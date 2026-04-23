from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from textwrap import wrap
import gc
import hashlib
import inspect
import logging
import math

from PIL import Image, ImageDraw, ImageFont, ImageOps
import torch

from .comfyui_runner import ComfyUICancelledError, ComfyUIRunner

try:
    from diffusers import (
        DiffusionPipeline,
        FlowMatchEulerDiscreteScheduler,
        GGUFQuantizationConfig,
        QwenImageEditPlusPipeline,
        QwenImagePipeline,
        QwenImageTransformer2DModel,
        StableDiffusionPipeline,
        StableDiffusionXLPipeline,
    )
except Exception:  # pragma: no cover - exercised through runtime fallback
    DiffusionPipeline = None
    FlowMatchEulerDiscreteScheduler = None
    GGUFQuantizationConfig = None
    QwenImageEditPlusPipeline = None
    QwenImagePipeline = None
    QwenImageTransformer2DModel = None
    StableDiffusionPipeline = None
    StableDiffusionXLPipeline = None

try:
    from gguf import GGUFReader
except Exception:  # pragma: no cover - exercised through runtime fallback
    GGUFReader = None


CHECKPOINT_EXTENSIONS = {".safetensors", ".ckpt", ".pt", ".pth"}
GGUF_EXTENSIONS = {".gguf"}
QWEN_EDIT_BASE_MODEL_ID = "Qwen/Qwen-Image-Edit-2511"
QWEN_TEXT_BASE_MODEL_ID = "Qwen/Qwen-Image"
QWEN_LIGHTNING_LORA_NAME = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors"
QWEN_WORKFLOW_SHIFT = 3.2
PREVIEW_MAX_DIMENSION = 1280
BASE_DIFFUSERS_HEADROOM_MB = 384
BASE_COMFYUI_HEADROOM_MB = 512
PER_MEGAPIXEL_HEADROOM_MB = 256
HIGH_STEP_THRESHOLD = 20
HIGH_STEP_EXTRA_HEADROOM_MB = 128
MAX_HEADROOM_MB = 2048


LOGGER = logging.getLogger(__name__)


class GenerationCancelledError(RuntimeError):
    """Raised when an in-flight image generation job is cancelled."""


@dataclass
class ReferenceImageInput:
    id: str
    file_name: str
    file_path: str | None
    mime_type: str | None
    size_bytes: int | None
    extracted_text: str | None
    created_at: str


@dataclass
class ImageGenerationRequest:
    prompt: str
    negative_prompt: str | None
    model: str
    width: int
    height: int
    steps: int
    guidance_scale: float
    seed: int | None
    output_path: str
    mode: str
    workflow_profile: str
    reference_images: list[ReferenceImageInput]


@dataclass
class VideoGenerationRequest:
    prompt: str
    negative_prompt: str | None
    model: str
    width: int
    height: int
    steps: int
    guidance_scale: float
    seed: int | None
    output_path: str
    mode: str
    workflow_profile: str
    reference_images: list[ReferenceImageInput]
    frame_count: int
    frame_rate: float
    high_noise_model: str
    low_noise_model: str


class ModelManager:
    """Tracks the currently loaded image model and executes local image jobs."""

    def __init__(self) -> None:
        self.loaded_model: str | None = None
        self.loaded_backend: str | None = None
        self.last_error: str | None = None
        self._pipeline = None
        self._pipeline_key: str | None = None
        self._active_generation_count = 0
        self._lock = Lock()
        self._comfyui_runner = ComfyUIRunner()

    def status(self) -> dict[str, object]:
        with self._lock:
            loaded_model = self.loaded_model
            loaded_backend = self.loaded_backend
            pipeline_key = self._pipeline_key
            active_generation_count = self._active_generation_count
            pipeline_loaded = self._pipeline is not None

        return {
            "loaded_model": loaded_model,
            "loaded_backend": loaded_backend,
            "cuda_available": torch.cuda.is_available(),
            "device": self._get_device_name(),
            "last_error": self.last_error,
            "active_generations": active_generation_count,
            "busy": active_generation_count > 0,
            "cached_pipeline_key": pipeline_key,
            "diffusers_pipeline_loaded": pipeline_loaded,
            "comfyui_sidecar_running": self._comfyui_runner.is_running(),
        }

    def estimate_vram(self) -> dict[str, object]:
        if not torch.cuda.is_available():
            return {
                "device": "cpu",
                "cuda_available": False,
                "total_mb": None,
                "free_mb": None,
                "reserved_mb": None,
                "allocated_mb": None,
            }

        device_index = torch.cuda.current_device()
        device = torch.device("cuda", device_index)
        reserved_bytes = torch.cuda.memory_reserved(device)
        allocated_bytes = torch.cuda.memory_allocated(device)

        # torch.cuda.mem_get_info (cudaMemGetInfo) is unreliable on Windows WDDM —
        # it ignores other processes' physical VRAM allocations (e.g. Ollama loaded
        # models). Use NVML instead, which returns real dedicated VRAM across all
        # processes, matching what Task Manager reports.
        try:
            from pynvml import nvmlInit, nvmlDeviceGetHandleByIndex, nvmlDeviceGetMemoryInfo  # type: ignore[import]
            nvmlInit()
            handle = nvmlDeviceGetHandleByIndex(device_index)
            info = nvmlDeviceGetMemoryInfo(handle)
            return {
                "device": f"cuda:{device_index}",
                "cuda_available": True,
                "total_mb": round(info.total / (1024 * 1024), 2),
                "free_mb": round(info.free / (1024 * 1024), 2),
                "reserved_mb": round(reserved_bytes / (1024 * 1024), 2),
                "allocated_mb": round(allocated_bytes / (1024 * 1024), 2),
            }
        except Exception:
            pass

        # Fallback: torch built-in (inaccurate on Windows WDDM, accurate on Linux)
        free_bytes, total_bytes = torch.cuda.mem_get_info(device)
        return {
            "device": str(device),
            "cuda_available": True,
            "total_mb": round(total_bytes / (1024 * 1024), 2),
            "free_mb": round(free_bytes / (1024 * 1024), 2),
            "reserved_mb": round(reserved_bytes / (1024 * 1024), 2),
            "allocated_mb": round(allocated_bytes / (1024 * 1024), 2),
        }

    def shutdown(self) -> None:
        self._clear_diffusers_runtime("Shutting down the Python inference worker")
        with self._lock:
            self.loaded_model = None
            self.loaded_backend = None
            self.last_error = None
            self._active_generation_count = 0

        self._comfyui_runner.shutdown()
        gc.collect()
        self._soft_empty_cache()

    def unload_idle_runtimes(self, reason: str) -> bool:
        with self._lock:
            active_generation_count = self._active_generation_count
            has_diffusers_pipeline = self._pipeline is not None
            has_placeholder_state = self.loaded_backend == "placeholder"

        if active_generation_count > 0:
            LOGGER.info(
                "Skipping generation runtime unload while %d job(s) are still active: %s",
                active_generation_count,
                reason,
            )
            return False

        had_comfyui_runtime = self._comfyui_runner.is_running()
        had_runtime = (
            has_diffusers_pipeline or had_comfyui_runtime or has_placeholder_state
        )

        self._clear_diffusers_runtime(reason)
        self._shutdown_comfyui_runtime(reason)
        had_runtime = self._clear_placeholder_runtime(reason) or had_runtime

        if had_runtime:
            self._soft_empty_cache()

        return had_runtime

    def generate_image(
        self,
        request: ImageGenerationRequest,
        progress_callback,
        is_cancelled,
    ) -> dict[str, object]:
        backend = self._resolve_backend_for_request(request)
        output_path = Path(request.output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self._mark_generation_started()

        try:
            self._prepare_runtime_for_request(request, backend)

            if backend == "placeholder":
                progress_callback(0.15, "Preparing placeholder renderer")
                self._raise_if_cancelled(is_cancelled)
                self._render_placeholder_image(request, output_path)
                progress_callback(1.0, "Placeholder image ready")
                with self._lock:
                    self.loaded_model = request.model
                    self.loaded_backend = "placeholder"
                self.last_error = None
                return self._build_result(output_path, request.width, request.height)

            if backend == "comfyui":
                progress_callback(0.08, "Preparing embedded ComfyUI backend")
                with self._lock:
                    self.loaded_model = request.model
                    self.loaded_backend = "comfyui"
                result = dict(
                    self._comfyui_runner.run_qwen_image_edit_workflow(
                        request=request,
                        progress_callback=progress_callback,
                        is_cancelled=is_cancelled,
                    )
                )
                if result.get("preview_path") is None and result.get("file_path"):
                    result["preview_path"] = self._create_preview_image(
                        Path(str(result["file_path"]))
                    )
                self.last_error = None
                return result

            progress_callback(0.1, "Loading image model")
            pipeline = self._load_pipeline(request)
            self._raise_if_cancelled(is_cancelled)
            progress_callback(0.25, "Running diffusion steps")
            result = self._run_generic_diffusers(
                pipeline=pipeline,
                request=request,
                progress_callback=progress_callback,
                is_cancelled=is_cancelled,
            )

            self.last_error = None
            return result
        except ComfyUICancelledError as error:
            raise GenerationCancelledError(str(error)) from error
        except GenerationCancelledError:
            raise
        except torch.cuda.OutOfMemoryError as error:
            self.last_error = str(error)
            self._recover_after_oom(backend)
            raise RuntimeError(self._format_oom_error(request, backend)) from error
        except Exception as error:
            self.last_error = str(error)
            if self._looks_like_oom(error):
                self._recover_after_oom(backend)
                raise RuntimeError(self._format_oom_error(request, backend)) from error
            raise
        finally:
            self._mark_generation_finished()
            self._soft_empty_cache()

    def generate_video(
        self,
        request: VideoGenerationRequest,
        progress_callback,
        is_cancelled,
    ) -> dict[str, object]:
        output_path = Path(request.output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        self._mark_generation_started()

        try:
            self._prepare_runtime_for_video_request(request)
            progress_callback(0.08, "Preparing embedded ComfyUI backend")
            with self._lock:
                self.loaded_model = request.model
                self.loaded_backend = "comfyui"
            result = dict(
                self._comfyui_runner.run_wan_image_to_video_workflow(
                    request=request,
                    progress_callback=progress_callback,
                    is_cancelled=is_cancelled,
                )
            )
            self.last_error = None
            return result
        except ComfyUICancelledError as error:
            raise GenerationCancelledError(str(error)) from error
        except GenerationCancelledError:
            raise
        except torch.cuda.OutOfMemoryError as error:
            self.last_error = str(error)
            self._recover_after_oom("comfyui")
            raise RuntimeError(self._format_video_oom_error(request)) from error
        except Exception as error:
            self.last_error = str(error)
            if self._looks_like_oom(error):
                self._recover_after_oom("comfyui")
                raise RuntimeError(self._format_video_oom_error(request)) from error
            raise
        finally:
            self._mark_generation_finished()
            self._soft_empty_cache()

    def _resolve_backend_for_request(self, request: ImageGenerationRequest) -> str:
        if request.workflow_profile == "qwen-image-edit-2511":
            return "comfyui"

        return self._resolve_backend(request.model)

    def _resolve_backend(self, model: str) -> str:
        if model.strip().lower() == "builtin:placeholder":
            return "placeholder"
        return "diffusers"

    def _get_device_name(self) -> str:
        if torch.cuda.is_available():
            device = torch.cuda.current_device()
            return f"cuda:{device} {torch.cuda.get_device_name(device)}"
        return "cpu"

    def _load_pipeline(self, request: ImageGenerationRequest):
        if (
            DiffusionPipeline is None
            and StableDiffusionPipeline is None
            and StableDiffusionXLPipeline is None
        ):
            raise RuntimeError(
                "diffusers is not available in the bundled Python runtime."
            )

        pipeline_key = self._get_pipeline_key(request)

        with self._lock:
            if self._pipeline_key == pipeline_key and self._pipeline is not None:
                return self._pipeline

        self._clear_mismatched_diffusers_pipeline(pipeline_key)
        self._ensure_vram_headroom(request, "diffusers")

        device = "cuda" if torch.cuda.is_available() else "cpu"
        torch_dtype = torch.float16 if torch.cuda.is_available() else torch.float32
        pipeline = self._build_pipeline(request, torch_dtype)

        if hasattr(pipeline, "set_progress_bar_config"):
            pipeline.set_progress_bar_config(disable=True)

        pipeline = pipeline.to(device)

        with self._lock:
            self._pipeline = pipeline
            self._pipeline_key = pipeline_key
            self.loaded_model = request.model
            self.loaded_backend = "diffusers"
            self.last_error = None

        return pipeline

    def _build_pipeline(self, request: ImageGenerationRequest, torch_dtype):
        return self._build_generic_pipeline(request.model, torch_dtype)

    def _build_generic_pipeline(self, model: str, torch_dtype):
        model_path = Path(model)

        if self._looks_like_local_path(model) and not model_path.exists():
            raise RuntimeError(f'The configured local image model "{model}" does not exist.')

        if model_path.exists() and model_path.is_file():
            return self._load_single_file_pipeline(model_path, torch_dtype)

        if DiffusionPipeline is None:
            raise RuntimeError(
                "diffusers directory loading is not available in the bundled Python runtime."
            )

        return DiffusionPipeline.from_pretrained(
            str(model_path) if model_path.exists() else model,
            torch_dtype=torch_dtype,
        )

    def _build_qwen_workflow_pipeline(
        self, request: ImageGenerationRequest, torch_dtype
    ):
        model_path = Path(request.model)

        if self._looks_like_local_path(request.model) and not model_path.exists():
            raise RuntimeError(
                f'The configured local Qwen workflow model "{request.model}" does not exist.'
            )

        if request.mode == "image-to-image":
            pipeline = self._build_qwen_image_edit_pipeline(request.model, torch_dtype)
        else:
            pipeline = self._build_qwen_text_generation_pipeline(
                request.model, torch_dtype
            )

        self._configure_qwen_scheduler(pipeline)
        self._try_load_qwen_lightning_lora(pipeline, model_path)
        return pipeline

    def _build_qwen_image_edit_pipeline(self, model: str, torch_dtype):
        if QwenImageEditPlusPipeline is None:
            raise RuntimeError(
                "Qwen Image Edit Plus is not available in the bundled Python runtime."
            )

        model_path = Path(model)
        transformer = None

        if model_path.exists() and model_path.is_file() and model_path.suffix.lower() in GGUF_EXTENSIONS:
            transformer = self._try_build_qwen_transformer(
                model_path=model_path,
                base_model_id=QWEN_EDIT_BASE_MODEL_ID,
                torch_dtype=torch_dtype,
            )

        if model_path.exists() and model_path.is_dir():
            return QwenImageEditPlusPipeline.from_pretrained(
                str(model_path), torch_dtype=torch_dtype
            )

        if transformer is not None:
            return QwenImageEditPlusPipeline.from_pretrained(
                QWEN_EDIT_BASE_MODEL_ID,
                transformer=transformer,
                torch_dtype=torch_dtype,
            )

        return QwenImageEditPlusPipeline.from_pretrained(
            QWEN_EDIT_BASE_MODEL_ID,
            torch_dtype=torch_dtype,
        )

    def _build_qwen_text_generation_pipeline(self, model: str, torch_dtype):
        if QwenImagePipeline is None:
            raise RuntimeError(
                "Qwen Image text generation is not available in the bundled Python runtime."
            )

        model_path = Path(model)
        transformer = None

        if model_path.exists() and model_path.is_file() and model_path.suffix.lower() in GGUF_EXTENSIONS:
            transformer = self._try_build_qwen_transformer(
                model_path=model_path,
                base_model_id=QWEN_TEXT_BASE_MODEL_ID,
                torch_dtype=torch_dtype,
            )

        if model_path.exists() and model_path.is_dir():
            return QwenImagePipeline.from_pretrained(
                str(model_path), torch_dtype=torch_dtype
            )

        if transformer is not None:
            return QwenImagePipeline.from_pretrained(
                QWEN_TEXT_BASE_MODEL_ID,
                transformer=transformer,
                torch_dtype=torch_dtype,
            )

        return QwenImagePipeline.from_pretrained(
            QWEN_TEXT_BASE_MODEL_ID,
            torch_dtype=torch_dtype,
        )

    def _try_build_qwen_transformer(self, model_path: Path, base_model_id: str, torch_dtype):
        if GGUFQuantizationConfig is None or QwenImageTransformer2DModel is None:
            raise RuntimeError(
                "Qwen GGUF transformer loading is not available in the bundled Python runtime."
            )

        quantization_config = GGUFQuantizationConfig(compute_dtype=torch_dtype)

        try:
            return QwenImageTransformer2DModel.from_single_file(
                str(model_path),
                config=base_model_id,
                subfolder="transformer",
                quantization_config=quantization_config,
                torch_dtype=torch_dtype,
            )
        except Exception:
            return None

    def _configure_qwen_scheduler(self, pipeline) -> None:
        if FlowMatchEulerDiscreteScheduler is None or not hasattr(pipeline, "scheduler"):
            return

        scheduler_config = dict(getattr(getattr(pipeline, "scheduler", None), "config", {}))
        scheduler_config.update({
            "base_image_seq_len": 256,
            "base_shift": math.log(QWEN_WORKFLOW_SHIFT),
            "invert_sigmas": False,
            "max_image_seq_len": 8192,
            "max_shift": math.log(QWEN_WORKFLOW_SHIFT),
            "num_train_timesteps": 1000,
            "shift": 1.0,
            "shift_terminal": None,
            "stochastic_sampling": False,
            "time_shift_type": "exponential",
            "use_beta_sigmas": False,
            "use_dynamic_shifting": True,
            "use_exponential_sigmas": False,
            "use_karras_sigmas": False,
        })

        pipeline.scheduler = FlowMatchEulerDiscreteScheduler.from_config(scheduler_config)

    def _try_load_qwen_lightning_lora(self, pipeline, model_path: Path) -> None:
        models_root = self._find_models_root(model_path)

        if models_root is None:
            return

        lora_path = models_root / "loras" / QWEN_LIGHTNING_LORA_NAME

        if not lora_path.exists():
            return

        try:
            pipeline.load_lora_weights(str(lora_path.parent), weight_name=lora_path.name)
        except Exception:
            return

    def _find_models_root(self, model_path: Path) -> Path | None:
        if not model_path:
            return None

        for parent in [model_path.parent, *model_path.parents]:
            if (parent / "loras").exists() and (parent / "vae").exists():
                return parent

        return None

    def _load_single_file_pipeline(self, model_path: Path, torch_dtype):
        suffix = model_path.suffix.lower()

        if suffix in GGUF_EXTENSIONS:
            return self._load_gguf_pipeline(model_path, torch_dtype)

        if suffix not in CHECKPOINT_EXTENSIONS:
            raise RuntimeError(
                f'Unsupported image checkpoint format "{model_path.suffix}".'
            )

        last_error: Exception | None = None

        for pipeline_class in (StableDiffusionXLPipeline, StableDiffusionPipeline):
            if pipeline_class is None:
                continue

            try:
                return pipeline_class.from_single_file(
                    str(model_path),
                    torch_dtype=torch_dtype,
                )
            except Exception as error:  # pragma: no cover - depends on model contents
                last_error = error

        if last_error is not None:
            raise RuntimeError(
                f'Unable to load checkpoint "{model_path.name}" as Stable Diffusion or SDXL weights: {last_error}'
            ) from last_error

        raise RuntimeError(
            "diffusers single-file checkpoint loading is not available in the bundled Python runtime."
        )

    def _load_gguf_pipeline(self, model_path: Path, torch_dtype):
        architecture = self._read_gguf_architecture(model_path)
        normalized_name = model_path.stem.lower()

        if architecture == "qwen_image":
            if "edit" in normalized_name:
                raise RuntimeError(
                    "This GGUF model targets the Qwen Image Edit workflow and must be run through the dedicated Qwen Image Edit 2511 path."
                )

            return self._load_qwen_image_gguf_pipeline(model_path, torch_dtype)

        if architecture == "wan":
            raise RuntimeError(
                "Wan GGUF models are reserved for the Video Gen milestone and cannot run in the current Image Gen flow yet."
            )

        raise RuntimeError(
            f'Unsupported GGUF image model "{model_path.name}". Only image-ready GGUF families wired into the desktop worker can be loaded.'
        )

    def _load_qwen_image_gguf_pipeline(self, model_path: Path, torch_dtype):
        if (
            QwenImageTransformer2DModel is None
            or QwenImagePipeline is None
            or GGUFQuantizationConfig is None
        ):
            raise RuntimeError(
                "Qwen Image GGUF loading is not available in the bundled Python runtime."
            )

        quantization_config = GGUFQuantizationConfig(compute_dtype=torch_dtype)
        base_model_id = QWEN_TEXT_BASE_MODEL_ID

        try:
            transformer = QwenImageTransformer2DModel.from_single_file(
                str(model_path),
                config=base_model_id,
                subfolder="transformer",
                quantization_config=quantization_config,
                torch_dtype=torch_dtype,
            )
            return QwenImagePipeline.from_pretrained(
                base_model_id,
                transformer=transformer,
                torch_dtype=torch_dtype,
            )
        except Exception as error:
            raise RuntimeError(
                "Unable to load the Qwen Image GGUF checkpoint. Ensure the base pipeline "
                '"Qwen/Qwen-Image" is available in the local Hugging Face cache or can be downloaded the first time it is used: '
                f"{error}"
            ) from error

    def _run_qwen_workflow(
        self,
        pipeline,
        request: ImageGenerationRequest,
        progress_callback,
        is_cancelled,
    ) -> dict[str, object]:
        kwargs: dict[str, object] = {
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt or " ",
            "true_cfg_scale": max(float(request.guidance_scale), 1.0),
            "guidance_scale": 1.0,
            "width": request.width,
            "height": request.height,
            "num_inference_steps": request.steps,
            "output_type": "pil",
        }

        if request.seed is not None:
            generator_device = "cuda" if torch.cuda.is_available() else "cpu"
            kwargs["generator"] = torch.Generator(device=generator_device).manual_seed(
                request.seed
            )

        call_signature = inspect.signature(pipeline.__call__)

        if "callback_on_step_end" in call_signature.parameters:
            kwargs["callback_on_step_end"] = self._build_step_callback(
                steps=request.steps,
                progress_callback=progress_callback,
                is_cancelled=is_cancelled,
            )

        if request.mode == "image-to-image":
            reference_images = self._load_reference_images(request.reference_images)

            if not reference_images:
                raise RuntimeError(
                    "Attach at least one reference image before starting an image-to-image Qwen workflow job."
                )

            kwargs["image"] = (
                reference_images
                if len(reference_images) > 1
                else reference_images[0]
            )

        result = pipeline(**kwargs)
        self._raise_if_cancelled(is_cancelled)
        image = result.images[0]
        progress_callback(0.95, "Saving image")
        image.save(request.output_path, format="PNG")
        progress_callback(1.0, "Image generation complete")
        return self._build_result(Path(request.output_path), image.width, image.height)

    def _run_generic_diffusers(
        self,
        pipeline,
        request: ImageGenerationRequest,
        progress_callback,
        is_cancelled,
    ) -> dict[str, object]:
        kwargs = {
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt or None,
            "width": request.width,
            "height": request.height,
            "num_inference_steps": request.steps,
            "guidance_scale": request.guidance_scale,
        }

        call_signature = inspect.signature(pipeline.__call__)
        kwargs = {
            key: value
            for key, value in kwargs.items()
            if key in call_signature.parameters and value is not None
        }

        if request.seed is not None and "generator" in call_signature.parameters:
            generator_device = "cuda" if torch.cuda.is_available() else "cpu"
            kwargs["generator"] = torch.Generator(device=generator_device).manual_seed(
                request.seed
            )

        if "callback_on_step_end" in call_signature.parameters:
            kwargs["callback_on_step_end"] = self._build_step_callback(
                steps=request.steps,
                progress_callback=progress_callback,
                is_cancelled=is_cancelled,
            )

        result = pipeline(**kwargs)
        self._raise_if_cancelled(is_cancelled)
        image = result.images[0]
        progress_callback(0.95, "Saving image")
        image.save(request.output_path, format="PNG")
        progress_callback(1.0, "Image generation complete")
        return self._build_result(Path(request.output_path), image.width, image.height)

    def _load_reference_images(
        self, reference_images: list[ReferenceImageInput]
    ) -> list[Image.Image]:
        loaded_images: list[Image.Image] = []

        for reference_image in reference_images:
            if not reference_image.file_path:
                raise RuntimeError(
                    f'Reference image "{reference_image.file_name}" does not have a local file path.'
                )

            image_path = Path(reference_image.file_path)

            if not image_path.exists():
                raise RuntimeError(
                    f'Reference image "{reference_image.file_name}" was not found at "{image_path}".'
                )

            with Image.open(image_path) as image:
                loaded_images.append(ImageOps.exif_transpose(image).convert("RGB"))

        return loaded_images

    def _read_gguf_architecture(self, model_path: Path) -> str | None:
        if GGUFReader is None:
            return None

        try:
            reader = GGUFReader(str(model_path))
            field = reader.get_field("general.architecture")
        except Exception:
            return None

        if field is None:
            return None

        for part in reversed(field.parts):
            if hasattr(part, "tobytes"):
                try:
                    value = part.tobytes().decode("utf-8", errors="ignore").strip("\x00")
                except Exception:
                    value = ""
            else:
                value = str(part)

            value = value.strip().lower()

            if value:
                return value

        return None

    def _looks_like_local_path(self, model: str) -> bool:
        normalized = model.strip()
        return (
            "\\" in normalized
            or normalized.startswith(".")
            or normalized.startswith("/")
            or (len(normalized) > 1 and normalized[1] == ":")
        )

    def _get_pipeline_key(self, request: ImageGenerationRequest) -> str:
        return f"{request.model}|{request.workflow_profile}|{request.mode}"

    def _prepare_runtime_for_request(
        self, request: ImageGenerationRequest, backend: str
    ) -> None:
        if backend == "placeholder":
            self._clear_diffusers_runtime("Switching to placeholder generation")
            self._shutdown_comfyui_runtime("Switching to placeholder generation")
            return

        if backend == "diffusers":
            self._shutdown_comfyui_runtime(
                "Switching from embedded ComfyUI to a diffusers pipeline"
            )
            return

        self._clear_diffusers_runtime(
            "Switching from diffusers to the embedded ComfyUI workflow"
        )

        if self._comfyui_runner.is_running() and self.loaded_model != request.model:
            self._shutdown_comfyui_runtime(
                "Switching to a different embedded ComfyUI model"
            )

        if not self._comfyui_runner.is_running():
            self._ensure_vram_headroom(request, "comfyui")

    def _prepare_runtime_for_video_request(self, request: VideoGenerationRequest) -> None:
        self._clear_diffusers_runtime(
            "Switching from diffusers to the embedded ComfyUI video workflow"
        )

        if self._comfyui_runner.is_running() and self.loaded_model != request.model:
            self._shutdown_comfyui_runtime(
                "Switching to a different embedded ComfyUI video model"
            )

        if not self._comfyui_runner.is_running():
            self._ensure_vram_headroom(request, "comfyui")

    def _clear_mismatched_diffusers_pipeline(self, pipeline_key: str) -> None:
        with self._lock:
            if self._pipeline is None or self._pipeline_key == pipeline_key:
                return

        self._clear_diffusers_runtime("Loading a different diffusers model")

    def _clear_diffusers_runtime(self, reason: str) -> None:
        with self._lock:
            pipeline = self._pipeline
            had_pipeline = pipeline is not None
            self._pipeline = None
            self._pipeline_key = None

            if self.loaded_backend == "diffusers":
                self.loaded_model = None
                self.loaded_backend = None

        if had_pipeline:
            LOGGER.info("Evicting cached diffusers pipeline: %s", reason)

        if pipeline is not None:
            self._discard_pipeline(pipeline)
            self._soft_empty_cache()

    def _clear_placeholder_runtime(self, reason: str) -> bool:
        with self._lock:
            if self.loaded_backend != "placeholder":
                return False

            self.loaded_model = None
            self.loaded_backend = None

        LOGGER.info("Clearing placeholder runtime state: %s", reason)
        return True

    def _shutdown_comfyui_runtime(self, reason: str) -> None:
        was_running = self._comfyui_runner.is_running()

        if was_running:
            LOGGER.info("Stopping embedded ComfyUI sidecar: %s", reason)
            self._comfyui_runner.shutdown()

        with self._lock:
            if self.loaded_backend == "comfyui":
                self.loaded_model = None
                self.loaded_backend = None

        if was_running:
            self._soft_empty_cache()

    def _discard_pipeline(self, pipeline) -> None:
        del pipeline
        gc.collect()

    def _ensure_vram_headroom(
        self,
        request: ImageGenerationRequest | VideoGenerationRequest,
        backend: str,
    ) -> None:
        if backend == "placeholder" or not torch.cuda.is_available():
            return

        required_headroom_mb = self._required_vram_headroom_mb(request, backend)
        free_mb = self._read_free_vram_mb()

        if free_mb is None or free_mb >= required_headroom_mb:
            return

        LOGGER.warning(
            "Free VRAM is below the preferred headroom for %s generation: %.0f MB free, %d MB required.",
            backend,
            free_mb,
            required_headroom_mb,
        )
        self._soft_empty_cache()
        free_mb = self._read_free_vram_mb()

        if free_mb is None or free_mb >= required_headroom_mb:
            return

        raise RuntimeError(
            "Insufficient free VRAM for this image job after unloading cached runtimes. "
            f"{free_mb:.0f} MB is currently free, while the {backend} path keeps a "
            f"{required_headroom_mb} MB safety headroom for model loading and sampling. "
            "Wait for other jobs to finish, reduce resolution or steps, or switch to a lighter model."
        )

    def _required_vram_headroom_mb(
        self,
        request: ImageGenerationRequest | VideoGenerationRequest,
        backend: str,
    ) -> int:
        base_headroom = (
            BASE_COMFYUI_HEADROOM_MB
            if backend == "comfyui"
            else BASE_DIFFUSERS_HEADROOM_MB
        )
        megapixels = max(1, math.ceil((request.width * request.height) / (1024 * 1024)))
        headroom = base_headroom + (megapixels * PER_MEGAPIXEL_HEADROOM_MB)

        if request.steps >= HIGH_STEP_THRESHOLD:
            headroom += HIGH_STEP_EXTRA_HEADROOM_MB

        return min(MAX_HEADROOM_MB, headroom)

    def _read_free_vram_mb(self) -> float | None:
        if not torch.cuda.is_available():
            return None

        device = torch.device("cuda", torch.cuda.current_device())
        free_bytes, _ = torch.cuda.mem_get_info(device)
        return round(free_bytes / (1024 * 1024), 2)

    def _looks_like_oom(self, error: Exception) -> bool:
        message = str(error).lower()
        return any(
            token in message
            for token in (
                "out of memory",
                "cuda oom",
                "cudnn_status_alloc_failed",
                "insufficient free vram",
            )
        )

    def _recover_after_oom(self, backend: str) -> None:
        if backend == "diffusers":
            self._clear_diffusers_runtime("Recovering from a CUDA OOM")
        elif backend == "comfyui":
            self._shutdown_comfyui_runtime("Recovering from a CUDA OOM")

        self._soft_empty_cache()

    def _format_oom_error(
        self, request: ImageGenerationRequest, backend: str
    ) -> str:
        required_headroom_mb = self._required_vram_headroom_mb(request, backend)
        free_mb = self._read_free_vram_mb()
        free_detail = (
            f"{free_mb:.0f} MB free after cleanup"
            if free_mb is not None
            else "free VRAM unavailable"
        )
        return (
            "Image generation ran out of VRAM. "
            f"The {backend} path targets about {required_headroom_mb} MB of free headroom for this request, and the worker recovered by evicting cached runtimes. "
            f"Current state: {free_detail}. "
            "Try a smaller resolution, fewer steps, or a lighter model."
        )

    def _format_video_oom_error(self, request: VideoGenerationRequest) -> str:
        required_headroom_mb = self._required_vram_headroom_mb(request, "comfyui")
        free_mb = self._read_free_vram_mb()
        free_detail = (
            f"{free_mb:.0f} MB free after cleanup"
            if free_mb is not None
            else "free VRAM unavailable"
        )
        return (
            "Video generation ran out of VRAM. "
            f"The embedded Wan 2.2 workflow targets about {required_headroom_mb} MB of free headroom for this request, and the worker recovered by evicting cached runtimes. "
            f"Current state: {free_detail}. "
            "Try a smaller frame size, fewer frames, or fewer total steps."
        )

    def _mark_generation_started(self) -> None:
        with self._lock:
            self._active_generation_count += 1

    def _mark_generation_finished(self) -> None:
        with self._lock:
            self._active_generation_count = max(0, self._active_generation_count - 1)

    def _build_step_callback(self, steps: int, progress_callback, is_cancelled):
        def callback_on_step_end(_pipeline, step_index, _timestep, callback_kwargs):
            self._raise_if_cancelled(is_cancelled)
            progress = 0.25 + (0.65 * ((step_index + 1) / max(steps, 1)))
            progress_callback(progress, f"Sampling step {step_index + 1}/{steps}")
            return callback_kwargs

        return callback_on_step_end

    def _render_placeholder_image(
        self, request: ImageGenerationRequest, output_path: Path
    ) -> None:
        seed_value = request.seed or int(
            hashlib.sha256(request.prompt.encode("utf-8")).hexdigest()[:8], 16
        )
        hue = seed_value % 360
        secondary_hue = (hue + 48) % 360
        image = Image.new("RGB", (request.width, request.height))
        draw = ImageDraw.Draw(image)

        for y in range(request.height):
            blend = y / max(request.height - 1, 1)
            red = int(
                (1 - blend) * (40 + (hue % 120))
                + blend * (15 + (secondary_hue % 160))
            )
            green = int(
                (1 - blend) * (90 + (secondary_hue % 90))
                + blend * (30 + (hue % 100))
            )
            blue = int(
                (1 - blend) * (150 + (hue % 60))
                + blend * (55 + (secondary_hue % 120))
            )
            draw.line((0, y, request.width, y), fill=(red % 255, green % 255, blue % 255))

        card_margin = max(24, request.width // 16)
        draw.rounded_rectangle(
            (
                card_margin,
                card_margin,
                request.width - card_margin,
                request.height - card_margin,
            ),
            radius=24,
            fill=(6, 11, 28, 215),
            outline=(115, 211, 255),
            width=2,
        )

        font = ImageFont.load_default()
        title = "Local placeholder image"
        body_lines = wrap(request.prompt, width=max(18, request.width // 20))[:8]
        draw.text(
            (card_margin + 18, card_margin + 18),
            title,
            fill=(220, 246, 255),
            font=font,
        )
        draw.text(
            (card_margin + 18, card_margin + 48),
            "\n".join(body_lines),
            fill=(229, 231, 235),
            font=font,
            spacing=6,
        )
        draw.text(
            (card_margin + 18, request.height - card_margin - 28),
            f"{request.width}x{request.height} | seed {seed_value}",
            fill=(125, 211, 252),
            font=font,
        )
        image.save(output_path, format="PNG")

    def _build_result(
        self, output_path: Path, width: int, height: int
    ) -> dict[str, object]:
        preview_path = self._create_preview_image(output_path)
        return {
            "file_path": str(output_path),
            "preview_path": preview_path,
            "mime_type": "image/png",
            "width": width,
            "height": height,
        }

    def _create_preview_image(self, image_path: Path) -> str | None:
        if not image_path.exists():
            return None

        preview_path = image_path.with_name(
            f"{image_path.stem}-preview{image_path.suffix or '.png'}"
        )

        try:
            with Image.open(image_path) as image:
                preview_image = ImageOps.exif_transpose(image)
                resampling_module = getattr(Image, "Resampling", Image)
                preview_image.thumbnail(
                    (PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION),
                    getattr(resampling_module, "LANCZOS"),
                )
                save_format = (image.format or "PNG").upper()
                preview_to_save = preview_image

                if save_format in {"JPEG", "JPG"} and preview_image.mode not in {"RGB", "L"}:
                    preview_to_save = preview_image.convert("RGB")

                preview_to_save.save(preview_path, format=save_format)
        except Exception:
            return None

        return str(preview_path)

    def _raise_if_cancelled(self, is_cancelled) -> None:
        if is_cancelled():
            raise GenerationCancelledError("Image generation was cancelled.")

    def _soft_empty_cache(self) -> None:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
