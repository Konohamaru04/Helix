from __future__ import annotations

import atexit
from dataclasses import dataclass
import hashlib
import json
import logging
import os
from pathlib import Path
import random
import shutil
import socket
from subprocess import PIPE, Popen
import sys
import tempfile
from threading import Lock, Thread
import time
from typing import TYPE_CHECKING, Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image

if TYPE_CHECKING:
    from .model_manager import ImageGenerationRequest


LOGGER = logging.getLogger(__name__)
COMFY_STARTUP_TIMEOUT_SECONDS = 180
COMFY_JOB_TIMEOUT_SECONDS = 1800
COMFY_POLL_INTERVAL_SECONDS = 0.5
HTTP_TIMEOUT_SECONDS = 15
QWEN_WORKFLOW_FILENAME = "Qwen Image Edit 2511 Texture Gen.json"
PRIMARY_EDIT_NODE_ID = "13"
NEGATIVE_EDIT_NODE_ID = "14"


class ComfyUICancelledError(RuntimeError):
    """Raised when an in-flight ComfyUI prompt is cancelled."""


@dataclass(frozen=True)
class QwenWorkflowDefaults:
    clip_name: str
    clip_type: str
    clip_device: str
    vae_name: str
    clip_vision_name: str
    primary_lora_name: str | None
    primary_lora_strength: float
    secondary_lora_name: str | None
    secondary_lora_strength: float
    tertiary_lora_name: str | None
    tertiary_lora_strength: float
    auraflow_shift: float
    cfg_norm_strength: float
    clip_conditioning_strength: float
    clip_conditioning_noise_augmentation: float
    sampler_name: str
    scheduler: str
    denoise: float
    resize_padding_color: str
    resize_interpolation: str


@dataclass(frozen=True)
class ComfyUIContext:
    runtime_key: str
    comfy_root: Path
    models_root: Path
    workflow_path: Path
    python_runtime: Path
    runtime_root: Path
    input_dir: Path
    output_dir: Path
    temp_dir: Path
    extra_model_paths_config: Path
    port: int
    base_url: str


@dataclass(frozen=True)
class StagedWorkflowInputs:
    prompt_id: str
    blank_image_name: str
    reference_image_names: list[str]
    created_files: list[Path]
    output_prefix: str
    prompt_seed: int


class ComfyUIRunner:
    """Runs local Qwen image workflows through the vendored ComfyUI runtime."""

    def __init__(self) -> None:
        self._context: ComfyUIContext | None = None
        self._process: Popen[str] | None = None
        self._lock = Lock()
        self._workflow_defaults_by_path: dict[Path, QwenWorkflowDefaults] = {}
        atexit.register(self.shutdown)

    def shutdown(self) -> None:
        with self._lock:
            process = self._shutdown_locked()

        if process is None:
            return

        if process.poll() is None:
            process.terminate()

            try:
                process.wait(timeout=10)
            except Exception:
                process.kill()

    def is_running(self) -> bool:
        with self._lock:
            return self._process is not None and self._process.poll() is None

    def _shutdown_locked(self) -> Popen[str] | None:
        process = self._process
        self._process = None
        self._context = None
        return process

    def run_qwen_image_edit_workflow(
        self,
        request: "ImageGenerationRequest",
        progress_callback,
        is_cancelled,
    ) -> dict[str, object]:
        context = self._ensure_server(Path(request.model))
        defaults = self._load_workflow_defaults(context.workflow_path)
        staged_inputs = self._stage_workflow_inputs(context, request)

        try:
            progress_callback(0.18, "Preparing embedded ComfyUI workflow")
            prompt = self._build_qwen_prompt(
                context=context,
                defaults=defaults,
                request=request,
                staged_inputs=staged_inputs,
            )
            self._submit_prompt(
                context=context,
                prompt_id=staged_inputs.prompt_id,
                prompt=prompt,
            )
            progress_callback(0.28, "Queued in embedded ComfyUI")
            output_path = self._wait_for_prompt(
                context=context,
                prompt_id=staged_inputs.prompt_id,
                request=request,
                progress_callback=progress_callback,
                is_cancelled=is_cancelled,
            )
            progress_callback(0.94, "Saving image")
            shutil.copy2(output_path, request.output_path)

            with Image.open(request.output_path) as image:
                width, height = image.size

            progress_callback(1.0, "Image generation complete")
            return {
                "file_path": request.output_path,
                "mime_type": "image/png",
                "width": width,
                "height": height,
            }
        finally:
            self._cleanup_job_files(context, staged_inputs)

    def _ensure_server(self, model_path: Path) -> ComfyUIContext:
        comfy_root = self._resolve_embedded_comfy_root()
        models_root = self._resolve_models_root(model_path)
        workflow_path = self._resolve_workflow_path(comfy_root)
        python_runtime = self._resolve_python_runtime()
        runtime_key = f"{comfy_root}|{models_root}"

        with self._lock:
            if (
                self._context is not None
                and self._context.runtime_key == runtime_key
                and self._process is not None
                and self._process.poll() is None
                and self._is_server_healthy(self._context)
            ):
                return self._context

            process = self._shutdown_locked()

        if process is not None and process.poll() is None:
            process.terminate()

            try:
                process.wait(timeout=10)
            except Exception:
                process.kill()

        runtime_hash = hashlib.sha256(runtime_key.encode("utf-8")).hexdigest()[:16]

        with self._lock:
            runtime_root = (
                Path(tempfile.gettempdir())
                / "ollama-desktop"
                / "comfyui-runtime"
                / runtime_hash
            )
            input_dir = runtime_root / "input"
            output_dir = runtime_root / "output"
            temp_dir = runtime_root / "temp"

            input_dir.mkdir(parents=True, exist_ok=True)
            output_dir.mkdir(parents=True, exist_ok=True)
            temp_dir.mkdir(parents=True, exist_ok=True)

            extra_model_paths_config = runtime_root / "extra_model_paths.yaml"
            extra_model_paths_config.write_text(
                self._build_extra_model_paths_yaml(models_root),
                encoding="utf-8",
            )

            port = self._find_free_port()
            context = ComfyUIContext(
                runtime_key=runtime_key,
                comfy_root=comfy_root,
                models_root=models_root,
                workflow_path=workflow_path,
                python_runtime=python_runtime,
                runtime_root=runtime_root,
                input_dir=input_dir,
                output_dir=output_dir,
                temp_dir=temp_dir,
                extra_model_paths_config=extra_model_paths_config,
                port=port,
                base_url=f"http://127.0.0.1:{port}",
            )
            self._process = self._start_process(context)
            self._context = context
            self._wait_until_healthy(context)
            return context

    def _start_process(self, context: ComfyUIContext) -> Popen[str]:
        bootstrap = "\n".join(
            [
                "import os",
                "from pathlib import Path",
                "import runpy",
                "import sys",
                "extra_paths = [entry for entry in os.environ.get('OLLAMA_DESKTOP_EXTRA_PYTHONPATH', '').split(os.pathsep) if entry]",
                "for entry in reversed(extra_paths):",
                "    if entry not in sys.path:",
                "        sys.path.insert(0, entry)",
                "root = Path(sys.argv[1]).resolve()",
                "root_str = str(root)",
                "sys.path = [root_str] + [path for path in sys.path if path != root_str]",
                "script = str(root / 'main.py')",
                "sys.argv = [script, *sys.argv[2:]]",
                "runpy.run_path(script, run_name='__main__')",
            ]
        )
        command = [
            str(context.python_runtime),
            "-c",
            bootstrap,
            str(context.comfy_root),
            "--listen",
            "127.0.0.1",
            "--port",
            str(context.port),
            "--disable-auto-launch",
            "--input-directory",
            str(context.input_dir),
            "--output-directory",
            str(context.output_dir),
            "--temp-directory",
            str(context.temp_dir),
            "--extra-model-paths-config",
            str(context.extra_model_paths_config),
            "--disable-metadata",
            "--lowvram",
            "--fast",
            "--verbose",
            "WARNING",
        ]
        env = {
            **dict(os.environ),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "DO_NOT_TRACK": "1",
        }
        process = Popen(
            command,
            cwd=str(context.comfy_root),
            env=env,
            stdout=PIPE,
            stderr=PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        if process.stdout is not None:
            Thread(
                target=self._drain_stream,
                args=(process.stdout, "stdout"),
                daemon=True,
            ).start()

        if process.stderr is not None:
            Thread(
                target=self._drain_stream,
                args=(process.stderr, "stderr"),
                daemon=True,
            ).start()

        return process

    def _drain_stream(self, stream, stream_name: str) -> None:
        for line in iter(stream.readline, ""):
            text = line.strip()

            if text:
                LOGGER.warning("Embedded ComfyUI %s: %s", stream_name, text)

        stream.close()

    def _wait_until_healthy(self, context: ComfyUIContext) -> None:
        deadline = time.monotonic() + COMFY_STARTUP_TIMEOUT_SECONDS

        while time.monotonic() < deadline:
            if self._process is None or self._process.poll() is not None:
                raise RuntimeError("Embedded ComfyUI exited before it became ready.")

            if self._is_server_healthy(context):
                return

            time.sleep(0.5)

        raise RuntimeError("Embedded ComfyUI did not become ready before the startup timeout.")

    def _is_server_healthy(self, context: ComfyUIContext) -> bool:
        try:
            self._request_json(context, "/queue")
            return True
        except Exception:
            return False

    def _stage_workflow_inputs(
        self, context: ComfyUIContext, request: "ImageGenerationRequest"
    ) -> StagedWorkflowInputs:
        prompt_id = f"ollama-desktop-{int(time.time() * 1000)}-{random.randint(1000, 9999)}"
        created_files: list[Path] = []
        reference_image_names: list[str] = []

        for index, reference_image in enumerate(request.reference_images[:3], start=1):
            if not reference_image.file_path:
                raise RuntimeError(
                    f'Reference image "{reference_image.file_name}" is missing a local path.'
                )

            source_path = Path(reference_image.file_path)

            if not source_path.exists():
                raise RuntimeError(
                    f'Reference image "{reference_image.file_name}" was not found at "{source_path}".'
                )

            suffix = source_path.suffix or ".png"
            target_name = f"{prompt_id}-reference-{index}{suffix}"
            target_path = context.input_dir / target_name
            shutil.copy2(source_path, target_path)
            created_files.append(target_path)
            reference_image_names.append(target_name)

        blank_image_name = f"{prompt_id}-blank.png"
        blank_image_path = context.input_dir / blank_image_name
        Image.new(
            "RGB",
            (max(request.width, 64), max(request.height, 64)),
            color=(255, 255, 255),
        ).save(blank_image_path, format="PNG")
        created_files.append(blank_image_path)

        return StagedWorkflowInputs(
            prompt_id=prompt_id,
            blank_image_name=blank_image_name,
            reference_image_names=reference_image_names,
            created_files=created_files,
            output_prefix=f"ollama-desktop/{prompt_id}/image",
            prompt_seed=request.seed
            if request.seed is not None
            else random.randint(0, 2**63 - 1),
        )

    def _build_qwen_prompt(
        self,
        context: ComfyUIContext,
        defaults: QwenWorkflowDefaults,
        request: "ImageGenerationRequest",
        staged_inputs: StagedWorkflowInputs,
    ) -> dict[str, object]:
        self._validate_required_assets(
            context.models_root,
            defaults,
            Path(request.model),
            request.mode,
        )
        negative_prompt = (request.negative_prompt or "").strip() or " "
        prompt: dict[str, object] = {
            "2": {
                "class_type": "CLIPLoader",
                "inputs": {
                    "clip_name": defaults.clip_name,
                    "type": defaults.clip_type,
                    "device": defaults.clip_device,
                },
            },
            "3": {
                "class_type": "VAELoader",
                "inputs": {
                    "vae_name": defaults.vae_name,
                },
            },
            "15": {
                "class_type": "UnetLoaderGGUF",
                "inputs": {
                    "unet_name": Path(request.model).name,
                },
            },
            "46": {
                "class_type": "LoadImage",
                "inputs": {
                    "image": staged_inputs.blank_image_name,
                    "upload": "image",
                },
            },
            "33": {
                "class_type": "ResizeAndPadImage",
                "inputs": {
                    "image": ["46", 0],
                    "target_width": request.width,
                    "target_height": request.height,
                    "padding_color": defaults.resize_padding_color,
                    "interpolation": defaults.resize_interpolation,
                },
            },
            "21": {
                "class_type": "VAEEncode",
                "inputs": {
                    "pixels": ["33", 0],
                    "vae": ["3", 0],
                },
            },
            "22": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["32", 0],
                    "vae": ["3", 0],
                },
            },
            "36": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["22", 0],
                    "filename_prefix": staged_inputs.output_prefix,
                },
            },
            PRIMARY_EDIT_NODE_ID: {
                "class_type": "NebulaTextEncodeQwenImageEditPlusNSFW",
                "inputs": {
                    "clip": ["2", 0],
                    "vae": ["3", 0],
                    "prompt": request.prompt,
                },
            },
            NEGATIVE_EDIT_NODE_ID: {
                "class_type": "NebulaTextEncodeQwenImageEditPlusNSFW",
                "inputs": {
                    "clip": ["2", 0],
                    "vae": ["3", 0],
                    "prompt": negative_prompt,
                },
            },
        }
        model_node_id = "15"

        for lora_node_id, lora_name, lora_strength in [
            ("16", defaults.primary_lora_name, defaults.primary_lora_strength),
            ("18", defaults.secondary_lora_name, defaults.secondary_lora_strength),
            ("17", defaults.tertiary_lora_name, defaults.tertiary_lora_strength),
        ]:
            if not lora_name:
                continue

            if lora_strength == 0 and not (context.models_root / "loras" / lora_name).exists():
                continue

            prompt[lora_node_id] = {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {
                    "model": [model_node_id, 0],
                    "lora_name": lora_name,
                    "strength_model": lora_strength,
                },
            }
            model_node_id = lora_node_id

        prompt["19"] = {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {
                "model": [model_node_id, 0],
                "shift": defaults.auraflow_shift,
            },
        }
        prompt["20"] = {
            "class_type": "CFGNorm",
            "inputs": {
                "model": ["19", 0],
                "strength": defaults.cfg_norm_strength,
            },
        }

        if request.mode == "image-to-image":
            # Fall back to the pre-generated blank white image when no reference images
            # are provided so the workflow can still run (text-driven edit on blank canvas).
            effective_reference_names = staged_inputs.reference_image_names or [
                staged_inputs.blank_image_name
            ]

            primary_reference_name = effective_reference_names[0]
            secondary_reference_name = (
                effective_reference_names[1]
                if len(effective_reference_names) > 1
                else primary_reference_name
            )
            prompt["4"] = {
                "class_type": "LoadImage",
                "inputs": {
                    "image": primary_reference_name,
                    "upload": "image",
                },
            }
            prompt["5"] = {
                "class_type": "LoadImage",
                "inputs": {
                    "image": secondary_reference_name,
                    "upload": "image",
                },
            }
            prompt["31"] = {
                "class_type": "CLIPVisionLoader",
                "inputs": {
                    "clip_name": defaults.clip_vision_name,
                },
            }
            prompt[PRIMARY_EDIT_NODE_ID]["inputs"]["image1"] = ["4", 0]
            prompt[PRIMARY_EDIT_NODE_ID]["inputs"]["image2"] = ["5", 0]
            prompt[NEGATIVE_EDIT_NODE_ID]["inputs"]["image1"] = ["4", 0]
            prompt[NEGATIVE_EDIT_NODE_ID]["inputs"]["image2"] = ["5", 0]

            if len(staged_inputs.reference_image_names) > 2:
                prompt["6"] = {
                    "class_type": "LoadImage",
                    "inputs": {
                        "image": staged_inputs.reference_image_names[2],
                        "upload": "image",
                    },
                }
                prompt[PRIMARY_EDIT_NODE_ID]["inputs"]["image3"] = ["6", 0]
                prompt[NEGATIVE_EDIT_NODE_ID]["inputs"]["image3"] = ["6", 0]

            prompt["23"] = {
                "class_type": "CLIPVisionEncode",
                "inputs": {
                    "clip_vision": ["31", 0],
                    "image": ["4", 0],
                    "crop": "none",
                },
            }
            prompt["24"] = {
                "class_type": "CLIPVisionEncode",
                "inputs": {
                    "clip_vision": ["31", 0],
                    "image": ["5", 0],
                    "crop": "none",
                },
            }

            for node_id, conditioning_node, clip_vision_node in [
                ("25", PRIMARY_EDIT_NODE_ID, "23"),
                ("26", PRIMARY_EDIT_NODE_ID, "24"),
                ("28", NEGATIVE_EDIT_NODE_ID, "23"),
                ("29", NEGATIVE_EDIT_NODE_ID, "24"),
            ]:
                prompt[node_id] = {
                    "class_type": "unCLIPConditioning",
                    "inputs": {
                        "conditioning": [conditioning_node, 0],
                        "clip_vision_output": [clip_vision_node, 0],
                        "strength": defaults.clip_conditioning_strength,
                        "noise_augmentation": defaults.clip_conditioning_noise_augmentation,
                    },
                }

            prompt["27"] = {
                "class_type": "ConditioningConcat",
                "inputs": {
                    "conditioning_to": ["25", 0],
                    "conditioning_from": ["26", 0],
                },
            }
            prompt["30"] = {
                "class_type": "ConditioningConcat",
                "inputs": {
                    "conditioning_to": ["28", 0],
                    "conditioning_from": ["29", 0],
                },
            }
            positive_node = "27"
            negative_node = "30"
        else:
            positive_node = PRIMARY_EDIT_NODE_ID
            negative_node = NEGATIVE_EDIT_NODE_ID

        prompt["32"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["20", 0],
                "positive": [positive_node, 0],
                "negative": [negative_node, 0],
                "latent_image": ["21", 0],
                "seed": staged_inputs.prompt_seed,
                "steps": request.steps,
                "cfg": max(float(request.guidance_scale), 1.0),
                "sampler_name": defaults.sampler_name,
                "scheduler": defaults.scheduler,
                "denoise": defaults.denoise,
            },
        }
        return prompt

    def _submit_prompt(
        self,
        context: ComfyUIContext,
        prompt_id: str,
        prompt: dict[str, object],
    ) -> None:
        self._request_json(
            context,
            "/prompt",
            method="POST",
            payload={
                "prompt_id": prompt_id,
                "prompt": prompt,
            },
        )

    def _wait_for_prompt(
        self,
        context: ComfyUIContext,
        prompt_id: str,
        request: "ImageGenerationRequest",
        progress_callback,
        is_cancelled,
    ) -> Path:
        deadline = time.monotonic() + COMFY_JOB_TIMEOUT_SECONDS
        cancellation_requested = False

        while time.monotonic() < deadline:
            if is_cancelled() and not cancellation_requested:
                self._cancel_prompt(context, prompt_id)
                cancellation_requested = True

            try:
                job = self._request_json(context, f"/api/jobs/{prompt_id}")
            except RuntimeError as error:
                if cancellation_requested:
                    raise ComfyUICancelledError("Image generation was cancelled.") from error
                raise

            status = str(job.get("status") or "")

            if status == "pending":
                progress_callback(0.34, "Queued in embedded ComfyUI")
            elif status == "in_progress":
                progress_callback(0.68, "Running embedded Qwen workflow")
            elif status == "completed":
                output_path = self._extract_output_path(job, context.output_dir)

                if output_path is None or not output_path.exists():
                    raise RuntimeError(
                        "Embedded ComfyUI completed the workflow but no output image was found."
                    )

                return output_path
            elif status == "cancelled":
                raise ComfyUICancelledError("Image generation was cancelled.")
            elif status == "failed":
                raise RuntimeError(self._extract_execution_error(job))

            time.sleep(COMFY_POLL_INTERVAL_SECONDS)

        raise RuntimeError("Embedded ComfyUI generation timed out before it completed.")

    def _cancel_prompt(self, context: ComfyUIContext, prompt_id: str) -> None:
        try:
            job = self._request_json(context, f"/api/jobs/{prompt_id}")
        except Exception:
            return

        status = str(job.get("status") or "")

        if status == "pending":
            self._request_json(
                context,
                "/queue",
                method="POST",
                payload={"delete": [prompt_id]},
            )
            return

        if status == "in_progress":
            self._request_json(
                context,
                "/interrupt",
                method="POST",
                payload={"prompt_id": prompt_id},
            )

    def _extract_output_path(self, job: dict[str, object], output_dir: Path) -> Path | None:
        outputs = job.get("outputs")

        if not isinstance(outputs, dict):
            return None

        for node_outputs in outputs.values():
            if not isinstance(node_outputs, dict):
                continue

            images = node_outputs.get("images")

            if not isinstance(images, list):
                continue

            for image_item in images:
                if not isinstance(image_item, dict):
                    continue

                filename = image_item.get("filename")
                subfolder = image_item.get("subfolder") or ""

                if not isinstance(filename, str) or not filename:
                    continue

                return output_dir / str(subfolder) / filename

        return None

    def _extract_execution_error(self, job: dict[str, object]) -> str:
        execution_error = job.get("execution_error")

        if isinstance(execution_error, dict):
            message = execution_error.get("message")
            details = execution_error.get("details")

            if isinstance(message, str) and isinstance(details, str) and details.strip():
                return f"{message}: {details}"

            if isinstance(message, str) and message.strip():
                return message

        return "Embedded ComfyUI failed to execute the Qwen image workflow."

    def _cleanup_job_files(
        self, context: ComfyUIContext, staged_inputs: StagedWorkflowInputs
    ) -> None:
        for file_path in staged_inputs.created_files:
            try:
                file_path.unlink(missing_ok=True)
            except Exception:
                LOGGER.warning("Unable to remove staged workflow input %s", file_path)

        prompt_output_directory = context.output_dir / "ollama-desktop" / staged_inputs.prompt_id

        if prompt_output_directory.exists():
            shutil.rmtree(prompt_output_directory, ignore_errors=True)

    def _resolve_embedded_comfy_root(self) -> Path:
        comfy_root = Path(__file__).resolve().parents[1] / "comfyui_backend" / "ComfyUI"

        if (comfy_root / "main.py").exists() and (comfy_root / "server.py").exists():
            return comfy_root

        raise RuntimeError(
            f'Unable to locate the vendored ComfyUI runtime at "{comfy_root}".'
        )

    def _resolve_models_root(self, model_path: Path) -> Path:
        for parent in [model_path.parent, *model_path.parents]:
            if (parent / "loras").exists() and (parent / "vae").exists():
                return parent

        raise RuntimeError(
            f'Unable to locate the local models root for "{model_path}". Expected sibling loras and vae directories.'
        )

    def _resolve_workflow_path(self, comfy_root: Path) -> Path:
        workflow_path = comfy_root / "user" / "default" / "workflows" / QWEN_WORKFLOW_FILENAME

        if workflow_path.exists():
            return workflow_path

        raise RuntimeError(
            f'Unable to locate the vendored Qwen Image Edit workflow JSON under "{comfy_root}".'
        )

    def _resolve_python_runtime(self) -> Path:
        runtime = Path(sys.executable)

        if runtime.exists():
            return runtime

        raise RuntimeError("Unable to resolve the bundled Python runtime for ComfyUI.")

    def _load_workflow_defaults(self, workflow_path: Path) -> QwenWorkflowDefaults:
        cached = self._workflow_defaults_by_path.get(workflow_path)

        if cached is not None:
            return cached

        workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        nodes = {
            str(node["id"]): node
            for node in workflow.get("nodes", [])
            if isinstance(node, dict) and "id" in node
        }

        def widget(node_id: str, index: int, fallback=None):
            node = nodes.get(node_id)

            if not node:
                return fallback

            values = node.get("widgets_values") or []
            return values[index] if index < len(values) else fallback

        defaults = QwenWorkflowDefaults(
            clip_name=str(widget("2", 0, "")),
            clip_type=str(widget("2", 1, "qwen_image")),
            clip_device=str(widget("2", 2, "default")),
            vae_name=str(widget("3", 0, "")),
            clip_vision_name=str(widget("31", 0, "")),
            primary_lora_name=self._coerce_optional_text(widget("16", 0)),
            primary_lora_strength=float(widget("16", 1, 1)),
            secondary_lora_name=self._coerce_optional_text(widget("18", 0)),
            secondary_lora_strength=float(widget("18", 1, 0)),
            tertiary_lora_name=self._coerce_optional_text(widget("17", 0)),
            tertiary_lora_strength=float(widget("17", 1, 0)),
            auraflow_shift=float(widget("19", 0, 3.2)),
            cfg_norm_strength=float(widget("20", 0, 1)),
            clip_conditioning_strength=float(widget("25", 0, 5)),
            clip_conditioning_noise_augmentation=float(widget("25", 1, 0)),
            sampler_name=str(widget("32", 4, "uni_pc")),
            scheduler=str(widget("32", 5, "sgm_uniform")),
            denoise=float(widget("32", 6, 1)),
            resize_padding_color=str(widget("33", 2, "white")),
            resize_interpolation=str(widget("33", 3, "nearest-exact")),
        )
        self._workflow_defaults_by_path[workflow_path] = defaults
        return defaults

    def _validate_required_assets(
        self,
        models_root: Path,
        defaults: QwenWorkflowDefaults,
        model_path: Path,
        mode: str,
    ) -> None:
        required_assets = [
            ("Qwen GGUF checkpoint", model_path),
            ("text encoder", models_root / "text_encoders" / defaults.clip_name),
            ("VAE", models_root / "vae" / defaults.vae_name),
        ]

        if defaults.primary_lora_name:
            required_assets.append(
                ("primary edit LoRA", models_root / "loras" / defaults.primary_lora_name)
            )

        if defaults.secondary_lora_name:
            required_assets.append(
                ("secondary workflow LoRA", models_root / "loras" / defaults.secondary_lora_name)
            )

        if defaults.tertiary_lora_name:
            required_assets.append(
                ("tertiary workflow LoRA", models_root / "loras" / defaults.tertiary_lora_name)
            )

        if mode == "image-to-image":
            required_assets.append(
                (
                    "CLIP vision encoder",
                    models_root / "clip_vision" / defaults.clip_vision_name,
                )
            )

        missing_assets = [
            f"{label} ({asset_path})"
            for label, asset_path in required_assets
            if not asset_path.exists()
        ]

        if missing_assets:
            raise RuntimeError(
                "The embedded Qwen Image Edit workflow is missing required ComfyUI assets: "
                + ", ".join(missing_assets)
            )

    def _request_json(
        self,
        context: ComfyUIContext,
        pathname: str,
        method: str = "GET",
        payload: dict[str, object] | None = None,
    ) -> Any:
        request = Request(
            url=f"{context.base_url}{pathname}",
            data=(json.dumps(payload).encode("utf-8") if payload is not None else None),
            headers={"Content-Type": "application/json"},
            method=method,
        )

        try:
            with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                body = response.read().decode("utf-8")

                if not body:
                    return None

                return json.loads(body)
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="ignore")
            message = body.strip() or f"HTTP {error.code} from embedded ComfyUI."

            try:
                payload = json.loads(body)
                if isinstance(payload, dict) and "error" in payload:
                    message = str(payload["error"])
            except Exception:
                pass

            raise RuntimeError(message) from error
        except URLError as error:
            raise RuntimeError(
                f"Unable to reach the embedded ComfyUI backend: {error.reason}"
            ) from error

    def _find_free_port(self) -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def _build_extra_model_paths_yaml(self, models_root: Path) -> str:
        normalized_root = models_root.as_posix()
        return "\n".join(
            [
                "ollama_desktop:",
                f"    base_path: {normalized_root}",
                "    checkpoints: checkpoints",
                "    text_encoders: |",
                "         text_encoders",
                "         clip",
                "    clip_vision: clip_vision",
                "    configs: configs",
                "    controlnet: controlnet",
                "    diffusion_models: |",
                "         diffusion_models",
                "         unet",
                "         transformer",
                "    embeddings: embeddings",
                "    loras: loras",
                "    upscale_models: upscale_models",
                "    vae: vae",
                "",
            ]
        )

    def _coerce_optional_text(self, value: object) -> str | None:
        if value is None:
            return None

        text = str(value).strip()
        return text or None
