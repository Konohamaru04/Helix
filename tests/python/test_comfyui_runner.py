from __future__ import annotations

from pathlib import Path

from inference_server.comfyui_runner import (
    ComfyUIRunner,
    QwenWorkflowDefaults,
)


def build_defaults() -> QwenWorkflowDefaults:
    return QwenWorkflowDefaults(
        clip_name="qwen2.5-vl-7b-instruct-abliterated.safetensors",
        clip_type="qwen_image",
        clip_device="default",
        vae_name="qwen_image_vae.safetensors",
        clip_vision_name="CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
        primary_lora_name="Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors",
        primary_lora_strength=1.0,
        secondary_lora_name="",
        secondary_lora_strength=0.0,
        tertiary_lora_name="",
        tertiary_lora_strength=0.0,
        auraflow_shift=3.2,
        cfg_norm_strength=1.0,
        clip_conditioning_strength=5.0,
        clip_conditioning_noise_augmentation=0.0,
        sampler_name="uni_pc",
        scheduler="sgm_uniform",
        denoise=1.0,
        resize_padding_color="white",
        resize_interpolation="nearest-exact",
    )


def test_resolve_embedded_comfy_root_points_inside_repo() -> None:
    runner = ComfyUIRunner()

    comfy_root = runner._resolve_embedded_comfy_root()

    assert comfy_root.exists()
    assert (comfy_root / "main.py").exists()
    assert (comfy_root / "server.py").exists()
    assert "OllamaDesktop" in str(comfy_root)


def test_validate_required_assets_requires_local_qwen_workflow_files(
    tmp_path: Path,
) -> None:
    models_root = tmp_path / "models"
    (models_root / "text_encoders").mkdir(parents=True)
    (models_root / "vae").mkdir(parents=True)
    (models_root / "clip_vision").mkdir(parents=True)
    (models_root / "loras").mkdir(parents=True)
    (models_root / "diffusion_models").mkdir(parents=True)

    model_path = models_root / "diffusion_models" / "Qwen-Image-Edit-2511-Q8_0.gguf"
    model_path.write_text("gguf", encoding="utf-8")
    (models_root / "text_encoders" / "qwen2.5-vl-7b-instruct-abliterated.safetensors").write_text(
        "clip",
        encoding="utf-8",
    )
    (models_root / "vae" / "qwen_image_vae.safetensors").write_text("vae", encoding="utf-8")
    (models_root / "clip_vision" / "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors").write_text(
        "clip-vision",
        encoding="utf-8",
    )
    (models_root / "loras" / "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors").write_text(
        "lora-1",
        encoding="utf-8",
    )
    (models_root / "loras" / "Qwen_Snofs_1_3.safetensors").write_text(
        "lora-2",
        encoding="utf-8",
    )

    runner = ComfyUIRunner()

    try:
        runner._validate_required_assets(
            models_root=models_root,
            defaults=build_defaults(),
            model_path=model_path,
            mode="image-to-image",
        )
    except RuntimeError as error:
        assert "tertiary workflow LoRA" in str(error)
        assert "qwen_2512_pussy_anus_v2.safetensors" in str(error)
    else:  # pragma: no cover - defensive assertion
        raise AssertionError("Expected the missing tertiary workflow LoRA to be reported.")
