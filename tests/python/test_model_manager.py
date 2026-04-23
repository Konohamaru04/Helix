from __future__ import annotations

from pathlib import Path

from PIL import Image
import torch

from inference_server import model_manager as model_manager_module
from inference_server.model_manager import (
    ImageGenerationRequest,
    ModelManager,
    VideoGenerationRequest,
)


def build_request(model: str) -> ImageGenerationRequest:
    return ImageGenerationRequest(
        prompt="A test image",
        negative_prompt=None,
        model=model,
        width=768,
        height=768,
        steps=6,
        guidance_scale=4,
        seed=1,
        output_path="result.png",
        mode="text-to-image",
        workflow_profile="default",
        reference_images=[],
    )


def test_build_pipeline_loads_local_diffusers_directory(monkeypatch, tmp_path: Path) -> None:
    model_directory = tmp_path / "sdxl-local"
    model_directory.mkdir()

    captured: dict[str, object] = {}

    class FakeDiffusionPipeline:
        @staticmethod
        def from_pretrained(model_path: str, torch_dtype):
            captured["model_path"] = model_path
            captured["torch_dtype"] = torch_dtype
            return "directory-pipeline"

    monkeypatch.setattr(model_manager_module, "DiffusionPipeline", FakeDiffusionPipeline)
    manager = ModelManager()

    pipeline = manager._build_pipeline(build_request(str(model_directory)), torch.float32)

    assert pipeline == "directory-pipeline"
    assert captured == {
        "model_path": str(model_directory),
        "torch_dtype": torch.float32,
    }


def test_build_pipeline_falls_back_between_single_file_loaders(
    monkeypatch, tmp_path: Path
) -> None:
    checkpoint_path = tmp_path / "dreamshaper.safetensors"
    checkpoint_path.write_text("", encoding="utf-8")
    attempted_loaders: list[str] = []

    class FailingSdxlPipeline:
        @staticmethod
        def from_single_file(model_path: str, torch_dtype):
            attempted_loaders.append(f"sdxl:{model_path}:{torch_dtype}")
            raise RuntimeError("not an SDXL checkpoint")

    class WorkingSdPipeline:
        @staticmethod
        def from_single_file(model_path: str, torch_dtype):
            attempted_loaders.append(f"sd:{model_path}:{torch_dtype}")
            return "single-file-pipeline"

    monkeypatch.setattr(model_manager_module, "StableDiffusionXLPipeline", FailingSdxlPipeline)
    monkeypatch.setattr(model_manager_module, "StableDiffusionPipeline", WorkingSdPipeline)
    manager = ModelManager()

    pipeline = manager._build_pipeline(build_request(str(checkpoint_path)), torch.float32)

    assert pipeline == "single-file-pipeline"
    assert attempted_loaders == [
        f"sdxl:{checkpoint_path}:{torch.float32}",
        f"sd:{checkpoint_path}:{torch.float32}",
    ]


def test_build_pipeline_rejects_missing_local_model_path() -> None:
    manager = ModelManager()

    missing_path = r"E:\missing\models\sdxl-local"

    try:
        manager._build_pipeline(build_request(missing_path), torch.float32)
    except RuntimeError as error:
        assert "does not exist" in str(error)
    else:  # pragma: no cover - defensive assertion
        raise AssertionError("Expected a missing local model path to raise RuntimeError.")


def test_build_pipeline_loads_qwen_image_gguf_with_base_pipeline(
    monkeypatch, tmp_path: Path
) -> None:
    gguf_path = tmp_path / "zimageTurbo.gguf"
    gguf_path.write_text("placeholder", encoding="utf-8")
    captured: dict[str, object] = {}

    class FakeGGUFQuantizationConfig:
        def __init__(self, compute_dtype):
            captured["compute_dtype"] = compute_dtype

    class FakeQwenTransformer:
        @staticmethod
        def from_single_file(
            model_path: str,
            config: str,
            subfolder: str,
            quantization_config,
            torch_dtype,
        ):
            captured["transformer_model_path"] = model_path
            captured["transformer_config"] = config
            captured["transformer_subfolder"] = subfolder
            captured["transformer_quantization_config"] = quantization_config
            captured["transformer_dtype"] = torch_dtype
            return "gguf-transformer"

    class FakeQwenPipeline:
        @staticmethod
        def from_pretrained(base_model_id: str, transformer, torch_dtype):
            captured["pipeline_base_model_id"] = base_model_id
            captured["pipeline_transformer"] = transformer
            captured["pipeline_dtype"] = torch_dtype
            return "qwen-gguf-pipeline"

    monkeypatch.setattr(
        model_manager_module,
        "GGUFQuantizationConfig",
        FakeGGUFQuantizationConfig,
    )
    monkeypatch.setattr(
        model_manager_module,
        "QwenImageTransformer2DModel",
        FakeQwenTransformer,
    )
    monkeypatch.setattr(model_manager_module, "QwenImagePipeline", FakeQwenPipeline)
    monkeypatch.setattr(
        ModelManager,
        "_read_gguf_architecture",
        lambda self, _model_path: "qwen_image",
    )
    manager = ModelManager()

    pipeline = manager._build_pipeline(build_request(str(gguf_path)), torch.float32)

    assert pipeline == "qwen-gguf-pipeline"
    assert captured["transformer_model_path"] == str(gguf_path)
    assert captured["transformer_config"] == "Qwen/Qwen-Image"
    assert captured["transformer_subfolder"] == "transformer"
    assert captured["pipeline_base_model_id"] == "Qwen/Qwen-Image"
    assert captured["pipeline_transformer"] == "gguf-transformer"
    assert captured["compute_dtype"] == torch.float32


def test_generate_image_routes_qwen_image_edit_workflow_through_embedded_comfyui(
    monkeypatch, tmp_path: Path
) -> None:
    gguf_path = tmp_path / "Qwen-Image-Edit.gguf"
    gguf_path.write_text("placeholder", encoding="utf-8")
    output_path = tmp_path / "result.png"
    captured: dict[str, object] = {}

    manager = ModelManager()
    manager._comfyui_runner = type(
        "FakeComfyUIRunner",
        (),
        {
            "is_running": staticmethod(lambda: False),
            "run_qwen_image_edit_workflow": staticmethod(
                lambda request, progress_callback, is_cancelled: (
                    captured.update(
                        {
                            "model": request.model,
                            "workflow_profile": request.workflow_profile,
                            "mode": request.mode,
                            "prompt": request.prompt,
                        }
                    )
                    or {
                        "file_path": str(output_path),
                        "mime_type": "image/png",
                        "width": 1664,
                        "height": 1248,
                    }
                )
            )
        },
    )()

    result = manager.generate_image(
        ImageGenerationRequest(
            prompt="Blend these references",
            negative_prompt="blur",
            model=str(gguf_path),
            width=1664,
            height=1248,
            steps=4,
            guidance_scale=1,
            seed=7,
            output_path=str(output_path),
            mode="image-to-image",
            workflow_profile="qwen-image-edit-2511",
            reference_images=[],
        ),
        lambda *_args, **_kwargs: None,
        lambda: False,
    )

    assert result["file_path"] == str(output_path)
    assert result["width"] == 1664
    assert result["height"] == 1248
    assert captured == {
        "model": str(gguf_path),
        "workflow_profile": "qwen-image-edit-2511",
        "mode": "image-to-image",
        "prompt": "Blend these references",
    }
    assert manager.loaded_backend == "comfyui"


def test_prepare_runtime_for_comfyui_evicts_cached_diffusers_pipeline(
    tmp_path: Path,
) -> None:
    gguf_path = tmp_path / "Qwen-Image-Edit.gguf"
    gguf_path.write_text("placeholder", encoding="utf-8")
    cache_flushes: list[str] = []

    manager = ModelManager()
    manager._pipeline = object()
    manager._pipeline_key = "old-model|default|text-to-image"
    manager.loaded_model = "old-model"
    manager.loaded_backend = "diffusers"
    manager._soft_empty_cache = lambda: cache_flushes.append("cache")
    manager._ensure_vram_headroom = lambda request, backend: None
    manager._comfyui_runner = type(
        "FakeComfyUIRunner",
        (),
        {
            "is_running": staticmethod(lambda: False),
            "shutdown": staticmethod(lambda: None),
        },
    )()

    manager._prepare_runtime_for_request(
        ImageGenerationRequest(
            prompt="Blend these references",
            negative_prompt=None,
            model=str(gguf_path),
            width=1664,
            height=1248,
            steps=4,
            guidance_scale=1,
            seed=7,
            output_path=str(tmp_path / "out.png"),
            mode="image-to-image",
            workflow_profile="qwen-image-edit-2511",
            reference_images=[],
        ),
        "comfyui",
    )

    assert manager._pipeline is None
    assert manager._pipeline_key is None
    assert manager.loaded_model is None
    assert manager.loaded_backend is None
    assert cache_flushes == ["cache"]


def test_prepare_runtime_for_diffusers_shuts_down_running_comfyui() -> None:
    shutdown_calls: list[str] = []
    manager = ModelManager()
    manager.loaded_model = "Qwen-Image-Edit.gguf"
    manager.loaded_backend = "comfyui"
    manager._comfyui_runner = type(
        "FakeComfyUIRunner",
        (),
        {
            "is_running": staticmethod(lambda: True),
            "shutdown": staticmethod(lambda: shutdown_calls.append("shutdown")),
        },
    )()

    manager._prepare_runtime_for_request(build_request("diffusers-model"), "diffusers")

    assert shutdown_calls == ["shutdown"]
    assert manager.loaded_model is None
    assert manager.loaded_backend is None


def test_build_pipeline_rejects_wan_gguf_in_current_flow(
    monkeypatch, tmp_path: Path
) -> None:
    gguf_path = tmp_path / "wan-video.gguf"
    gguf_path.write_text("placeholder", encoding="utf-8")
    monkeypatch.setattr(
        ModelManager,
        "_read_gguf_architecture",
        lambda self, _model_path: "wan",
    )
    manager = ModelManager()

    try:
        manager._build_pipeline(build_request(str(gguf_path)), torch.float32)
    except RuntimeError as error:
        assert "Video Gen milestone" in str(error)
    else:  # pragma: no cover - defensive assertion
        raise AssertionError("Expected Wan GGUF to raise RuntimeError.")


def test_generate_video_routes_wan_image_to_video_workflow_through_embedded_comfyui(
    tmp_path: Path,
) -> None:
    high_noise_model = tmp_path / "DasiwaWAN22I2V14BSynthseduction_q8High.gguf"
    low_noise_model = tmp_path / "DasiwaWAN22I2V14BSynthseduction_q8Low.gguf"
    output_path = tmp_path / "result.mp4"
    captured: dict[str, object] = {}

    high_noise_model.write_text("high", encoding="utf-8")
    low_noise_model.write_text("low", encoding="utf-8")

    manager = ModelManager()
    manager._comfyui_runner = type(
        "FakeComfyUIRunner",
        (),
        {
            "is_running": staticmethod(lambda: False),
            "run_wan_image_to_video_workflow": staticmethod(
                lambda request, progress_callback, is_cancelled: (
                    captured.update(
                        {
                            "model": request.model,
                            "workflow_profile": request.workflow_profile,
                            "mode": request.mode,
                            "frame_count": request.frame_count,
                            "frame_rate": request.frame_rate,
                            "high_noise_model": request.high_noise_model,
                            "low_noise_model": request.low_noise_model,
                        }
                    )
                    or {
                        "file_path": str(output_path),
                        "preview_path": None,
                        "mime_type": "video/mp4",
                        "width": 528,
                        "height": 704,
                    }
                )
            ),
        },
    )()

    result = manager.generate_video(
        VideoGenerationRequest(
            prompt="Add a slow camera orbit",
            negative_prompt="static frame",
            model=str(high_noise_model),
            width=528,
            height=704,
            steps=8,
            guidance_scale=1,
            seed=5,
            output_path=str(output_path),
            mode="image-to-video",
            workflow_profile="wan-image-to-video",
            reference_images=[],
            frame_count=81,
            frame_rate=16.0,
            high_noise_model=str(high_noise_model),
            low_noise_model=str(low_noise_model),
        ),
        lambda *_args, **_kwargs: None,
        lambda: False,
    )

    assert result["file_path"] == str(output_path)
    assert result["mime_type"] == "video/mp4"
    assert captured == {
        "model": str(high_noise_model),
        "workflow_profile": "wan-image-to-video",
        "mode": "image-to-video",
        "frame_count": 81,
        "frame_rate": 16.0,
        "high_noise_model": str(high_noise_model),
        "low_noise_model": str(low_noise_model),
    }
    assert manager.loaded_backend == "comfyui"


def test_build_result_creates_a_smaller_preview_image(tmp_path: Path) -> None:
    output_path = tmp_path / "result.png"
    Image.new("RGB", (1664, 1248), color=(12, 34, 56)).save(output_path, format="PNG")
    manager = ModelManager()

    result = manager._build_result(output_path, 1664, 1248)

    assert result["file_path"] == str(output_path)
    assert result["preview_path"] is not None

    preview_path = Path(str(result["preview_path"]))
    assert preview_path.exists()

    with Image.open(preview_path) as preview_image:
        assert max(preview_image.size) <= 1280
