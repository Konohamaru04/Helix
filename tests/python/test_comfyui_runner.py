from __future__ import annotations

from pathlib import Path

from inference_server.comfyui_runner import (
    ComfyUIContext,
    ComfyUIRunner,
    QwenWorkflowDefaults,
    StagedVideoWorkflowInputs,
)
from inference_server.model_manager import ReferenceImageInput, VideoGenerationRequest


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


def test_validate_required_assets_accepts_missing_optional_qwen_loras_when_not_configured(
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

    runner._validate_required_assets(
        models_root=models_root,
        defaults=build_defaults(),
        model_path=model_path,
        mode="image-to-image",
    )


def test_validate_wan_required_assets_requires_both_noise_models(
    tmp_path: Path,
) -> None:
    models_root = tmp_path / "models"
    (models_root / "text_encoders").mkdir(parents=True)
    (models_root / "vae").mkdir(parents=True)
    (models_root / "clip_vision").mkdir(parents=True)

    (models_root / "text_encoders" / "umt5_xxl_fp8_e4m3fn_scaled.safetensors").write_text(
        "clip",
        encoding="utf-8",
    )
    (models_root / "vae" / "wan_2.1_vae.safetensors").write_text(
        "vae",
        encoding="utf-8",
    )
    (models_root / "clip_vision" / "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors").write_text(
        "clip-vision",
        encoding="utf-8",
    )

    high_noise_model = models_root / "diffusion_models" / "wan-high.gguf"
    low_noise_model = models_root / "diffusion_models" / "wan-low.gguf"
    high_noise_model.parent.mkdir(parents=True)
    high_noise_model.write_text("high", encoding="utf-8")

    runner = ComfyUIRunner()

    try:
        runner._validate_wan_required_assets(
            models_root=models_root,
            clip_name="umt5_xxl_fp8_e4m3fn_scaled.safetensors",
            vae_name="wan_2.1_vae.safetensors",
            clip_vision_name="CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
            high_noise_model=high_noise_model,
            low_noise_model=low_noise_model,
        )
    except RuntimeError as error:
        assert "low-noise Wan model" in str(error)
        assert str(low_noise_model) in str(error)
    else:  # pragma: no cover - defensive assertion
        raise AssertionError("Expected the missing low-noise Wan model to be reported.")


def test_build_wan_image_to_video_prompt_builds_sampler_steps_without_runtime_errors(
    tmp_path: Path,
) -> None:
    models_root = tmp_path / "models"
    (models_root / "text_encoders").mkdir(parents=True)
    (models_root / "vae").mkdir(parents=True)
    (models_root / "clip_vision").mkdir(parents=True)
    (models_root / "diffusion_models").mkdir(parents=True)

    (models_root / "text_encoders" / "umt5_xxl_fp8_e4m3fn_scaled.safetensors").write_text(
        "clip",
        encoding="utf-8",
    )
    (models_root / "vae" / "wan_2.1_vae.safetensors").write_text(
        "vae",
        encoding="utf-8",
    )
    (models_root / "clip_vision" / "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors").write_text(
        "clip-vision",
        encoding="utf-8",
    )

    high_noise_model = models_root / "diffusion_models" / "wan-q8High.gguf"
    low_noise_model = models_root / "diffusion_models" / "wan-q8Low.gguf"
    high_noise_model.write_text("high", encoding="utf-8")
    low_noise_model.write_text("low", encoding="utf-8")

    runner = ComfyUIRunner()
    context = ComfyUIContext(
        runtime_key="test",
        comfy_root=tmp_path,
        models_root=models_root,
        workflow_path=tmp_path / "workflow.json",
        python_runtime=tmp_path / "python.exe",
        runtime_root=tmp_path / "runtime",
        input_dir=tmp_path / "input",
        output_dir=tmp_path / "output",
        temp_dir=tmp_path / "temp",
        extra_model_paths_config=tmp_path / "extra-model-paths.yaml",
        port=8188,
        base_url="http://127.0.0.1:8188",
    )
    staged_inputs = StagedVideoWorkflowInputs(
        prompt_id="test-prompt",
        reference_image_name="reference.png",
        created_files=[],
        output_prefix="ollama-desktop/test-prompt/video",
        prompt_seed=11,
    )
    request = VideoGenerationRequest(
        prompt="Add a gentle camera orbit",
        negative_prompt="static frame",
        model=str(high_noise_model),
        width=528,
        height=704,
        steps=8,
        guidance_scale=1,
        seed=11,
        output_path=str(tmp_path / "output.mp4"),
        mode="image-to-video",
        workflow_profile="wan-image-to-video",
        reference_images=[
            ReferenceImageInput(
                id="ref-1",
                file_name="reference.png",
                file_path=str(tmp_path / "reference.png"),
                mime_type="image/png",
                size_bytes=128,
                extracted_text=None,
                created_at="2026-04-23T00:00:00.000Z",
            )
        ],
        frame_count=81,
        frame_rate=16,
        high_noise_model=str(high_noise_model),
        low_noise_model=str(low_noise_model),
    )

    prompt = runner._build_wan_image_to_video_prompt(
        context=context,
        request=request,
        staged_inputs=staged_inputs,
    )

    assert prompt["12"]["class_type"] == "UnetLoaderGGUF"
    assert prompt["14"]["class_type"] == "UnetLoaderGGUF"
    assert prompt["17"]["inputs"]["end_at_step"] == 4
    assert prompt["18"]["inputs"]["start_at_step"] == 4
    assert prompt["22"]["class_type"] == "RIFE VFI"
    assert prompt["22"]["inputs"]["frames"] == ["19", 0]
    assert prompt["22"]["inputs"]["ckpt_name"] == "rife49.pth"
    assert prompt["20"]["inputs"]["images"] == ["22", 0]
    assert prompt["21"]["class_type"] == "SaveVideo"
