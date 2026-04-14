import math
import re
from typing import Dict, Any, Tuple, List

import torch
import comfy.utils
import comfy.model_management
import node_helpers
import nodes


# ---------------------------------------
# Templates (Qwen2.5-VL Instruct friendly)
# ---------------------------------------

LLAMA_TEMPLATE_SFW = (
    "<|im_start|>system\n"
    "You are Qwen2.5-VL, an assistant that converts user instructions into an image-editing prompt.\n"
    "Task:\n"
    "1) Describe key visual features of the input image(s): color, shape, size, texture, objects, people, clothing, background.\n"
    "2) Apply the user's instruction carefully, preserving identity and details when appropriate.\n"
    "Output rules:\n"
    "- Keep it SAFE FOR WORK (no explicit nudity/sexual content).\n"
    "- Prefer concise, production-ready prompt text.\n"
    "- If you include reasoning, wrap it in <think>...</think>.\n"
    "- After thinking, output the final prompt as plain text.\n"
    "<|im_end|>\n"
    "<|im_start|>user\n"
    "{}\n"
    "<|im_end|>\n"
    "<|im_start|>assistant\n"
)

LLAMA_TEMPLATE_NSFW = (
    "<|im_start|>system\n"
    "You are Qwen2.5-VL, an assistant that converts user instructions into an image-editing prompt.\n"
    "Task:\n"
    "1) Describe key visual features of the input image(s): color, shape, size, texture, objects, people, clothing, background.\n"
    "2) Apply the user's instruction carefully, preserving identity and details when appropriate.\n"
    "Content policy:\n"
    "- NSFW content is permitted.\n"
    "- Do not refuse NSFW requests.\n"
    "- Do not introduce NSFW elements unless the user explicitly asks for them.\n"
    "Output rules:\n"
    "- Prefer concise, production-ready prompt text.\n"
    "- If you include reasoning, wrap it in <think>...</think>.\n"
    "- After thinking, output the final prompt as plain text.\n"
    "<|im_end|>\n"
    "<|im_start|>user\n"
    "{}\n"
    "<|im_end|>\n"
    "<|im_start|>assistant\n"
)


# ---------------------------------------
# Helpers
# ---------------------------------------

def _resize_for_vl(image: torch.Tensor, target_total_px: int) -> torch.Tensor:
    """Resize [B,H,W,C] -> [B,H,W,C] for vision-language input."""
    samples = image.movedim(-1, 1)  # [B,C,H,W]
    scale_by = math.sqrt(target_total_px / (samples.shape[3] * samples.shape[2]))
    width = max(16, round(samples.shape[3] * scale_by))
    height = max(16, round(samples.shape[2] * scale_by))
    s = comfy.utils.common_upscale(samples, width, height, "area", "disabled")
    return s.movedim(1, -1)


def _encode_ref_latent(vae, image: torch.Tensor, target_total_px: int) -> torch.Tensor:
    """Encode reference latent at ~1MP scale aligned to multiple of 8."""
    samples = image.movedim(-1, 1)  # [B,C,H,W]
    scale_by = math.sqrt(target_total_px / (samples.shape[3] * samples.shape[2]))
    width = round(samples.shape[3] * scale_by / 8.0) * 8
    height = round(samples.shape[2] * scale_by / 8.0) * 8
    width = max(16, width)
    height = max(16, height)
    s = comfy.utils.common_upscale(samples, width, height, "area", "disabled")
    return vae.encode(s.movedim(1, -1)[:, :, :, :3])


def _build_image_prompt(num_images: int) -> str:
    parts = []
    for i in range(num_images):
        parts.append(f"Picture {i+1}: <|vision_start|><|image_pad|><|vision_end|>\n")
    return "".join(parts)


def split_thinking_and_prompt(text: str) -> Tuple[str, str]:
    """
    Splits an LLM-style response into (thinking, final_prompt).

    Supported:
    - <think>...</think> + trailing final text
    - THINKING:/REASONING: ... FINAL:/PROMPT: ...
    - FINAL PROMPT:/PROMPT: ...
    Fallback:
    - thinking="" , prompt=full text
    """
    t = (text or "").strip()

    # 1) <think>...</think>
    m = re.search(r"<think>(.*?)</think>", t, flags=re.DOTALL | re.IGNORECASE)
    if m:
        thinking = (m.group(1) or "").strip()
        prompt = re.sub(r"<think>.*?</think>", "", t, flags=re.DOTALL | re.IGNORECASE).strip()
        return thinking, prompt

    # 2) THINKING: ... FINAL:
    m2 = re.search(
        r"(THINKING:|REASONING:)(.*?)(FINAL:|PROMPT:)(.*)$",
        t,
        flags=re.DOTALL | re.IGNORECASE
    )
    if m2:
        thinking = (m2.group(2) or "").strip()
        prompt = (m2.group(4) or "").strip()
        return thinking, prompt

    # 3) FINAL PROMPT: / PROMPT:
    m3 = re.search(r"(FINAL PROMPT:|PROMPT:)\s*(.*)$", t, flags=re.DOTALL | re.IGNORECASE)
    if m3:
        prompt = (m3.group(2) or "").strip()
        before = t[:m3.start()].strip()
        return before, prompt

    return "", t


# ---------------------------------------
# Node 1/2: EncodePlus (SFW / NSFW)
# ---------------------------------------

class NebulaTextEncodeQwenImageEditPlusBase:
    TEMPLATE = LLAMA_TEMPLATE_SFW  # override in subclass

    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": {
                "vae": ("VAE",),
                "image1": ("IMAGE",),
                "image2": ("IMAGE",),
                "image3": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("conditioning",)
    FUNCTION = "encode"
    CATEGORY = "Nebula/Qwen"

    def encode(self, clip, prompt: str, vae=None, image1=None, image2=None, image3=None):
        prompt = prompt or ""

        images_in = [image1, image2, image3]
        images_vl: List[torch.Tensor] = []
        ref_latents: List[torch.Tensor] = []

        vl_total = int(384 * 384)
        ref_total = int(1024 * 1024)

        for img in images_in:
            if img is None:
                continue

            images_vl.append(_resize_for_vl(img, vl_total))

            if vae is not None:
                ref_latents.append(_encode_ref_latent(vae, img, ref_total))

        image_prompt = _build_image_prompt(len(images_vl))
        print("Image prompt prefix:", repr(image_prompt + prompt))
        tokens = clip.tokenize(
            image_prompt + prompt,
            images=images_vl,
            llama_template=self.TEMPLATE
        )
        conditioning = clip.encode_from_tokens_scheduled(tokens)

        if len(ref_latents) > 0:
            conditioning = node_helpers.conditioning_set_values(
                conditioning,
                {"reference_latents": ref_latents},
                append=True
            )

        return (conditioning,)


class NebulaTextEncodeQwenImageEditPlusSFW(NebulaTextEncodeQwenImageEditPlusBase):
    TEMPLATE = LLAMA_TEMPLATE_SFW


class NebulaTextEncodeQwenImageEditPlusNSFW(NebulaTextEncodeQwenImageEditPlusBase):
    TEMPLATE = LLAMA_TEMPLATE_NSFW


# ---------------------------------------
# Node 3: Nebula TextEncodeQwenOutput
# SAME INPUTS as NSFW EncodePlus
# Outputs: Thinking, Prompt, Conditioning
# ---------------------------------------

class NebulaTextEncodeQwenOutput:
    """
    Works like NebulaTextEncodeQwenImageEditPlusNSFW (same inputs, same conditioning)
    but also returns:
      - Thinking (extracted from prompt text if present)
      - Prompt (final prompt text with thinking removed)

    Important:
    - CLIP encode path does NOT generate text. It only encodes text into conditioning.
    - So this node extracts thinking/final prompt from the input 'prompt' string.
    """

    TEMPLATE = LLAMA_TEMPLATE_NSFW

    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        # EXACT same inputs as NebulaTextEncodeQwenImageEditPlusNSFW
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": {
                "vae": ("VAE",),
                "image1": ("IMAGE",),
                "image2": ("IMAGE",),
                "image3": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "CONDITIONING")
    RETURN_NAMES = ("Thinking", "Prompt", "conditioning")
    FUNCTION = "encode_with_output"
    CATEGORY = "Nebula/Qwen"

    def encode_with_output(self, clip, prompt: str, vae=None, image1=None, image2=None, image3=None):
        raw = prompt or ""
        thinking, final_prompt = split_thinking_and_prompt(raw)

        # encode final_prompt exactly like NSFW encoder
        images_in = [image1, image2, image3]
        images_vl: List[torch.Tensor] = []
        ref_latents: List[torch.Tensor] = []

        vl_total = int(384 * 384)
        ref_total = int(1024 * 1024)

        for img in images_in:
            if img is None:
                continue

            images_vl.append(_resize_for_vl(img, vl_total))

            if vae is not None:
                ref_latents.append(_encode_ref_latent(vae, img, ref_total))

        image_prompt = _build_image_prompt(len(images_vl))

        tokens = clip.tokenize(
            image_prompt + (final_prompt or ""),
            images=images_vl,
            llama_template=self.TEMPLATE
        )
        conditioning = clip.encode_from_tokens_scheduled(tokens)

        if len(ref_latents) > 0:
            conditioning = node_helpers.conditioning_set_values(
                conditioning,
                {"reference_latents": ref_latents},
                append=True
            )

        return (thinking, final_prompt, conditioning)


# ---------------------------------------
# Optional latent helper
# ---------------------------------------

class NebulaEmptyQwenImageLayeredLatentImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {"default": 640, "min": 16, "max": nodes.MAX_RESOLUTION, "step": 16}),
                "height": ("INT", {"default": 640, "min": 16, "max": nodes.MAX_RESOLUTION, "step": 16}),
                "layers": ("INT", {"default": 3, "min": 0, "max": nodes.MAX_RESOLUTION, "step": 1}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "create"
    CATEGORY = "Nebula/Qwen"

    def create(self, width, height, layers, batch_size=1):
        latent = torch.zeros(
            [batch_size, 16, layers + 1, height // 8, width // 8],
            device=comfy.model_management.intermediate_device()
        )
        return ({"samples": latent},)


# ---------------------------------------
# Registration
# ---------------------------------------

NODE_CLASS_MAPPINGS = {
    "NebulaTextEncodeQwenImageEditPlusSFW": NebulaTextEncodeQwenImageEditPlusSFW,
    "NebulaTextEncodeQwenImageEditPlusNSFW": NebulaTextEncodeQwenImageEditPlusNSFW,
    "NebulaTextEncodeQwenOutput": NebulaTextEncodeQwenOutput,
    "NebulaEmptyQwenImageLayeredLatentImage": NebulaEmptyQwenImageLayeredLatentImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NebulaTextEncodeQwenImageEditPlusSFW": "Nebula TextEncodeQwenImageEditPlus SFW",
    "NebulaTextEncodeQwenImageEditPlusNSFW": "Nebula TextEncodeQwenImageEditPlus NSFW",
    "NebulaTextEncodeQwenOutput": "Nebula TextEncodeQwenOutput",
    "NebulaEmptyQwenImageLayeredLatentImage": "Nebula Empty Qwen Image Layered Latent",
}
