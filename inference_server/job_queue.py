from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Literal
from uuid import uuid4

from .model_manager import (
    GenerationCancelledError,
    ImageGenerationRequest,
    ModelManager,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


PERSISTED_QUEUE_STATE_VERSION = 1


@dataclass
class JobArtifact:
    id: str
    job_id: str
    kind: Literal["image"]
    file_path: str
    preview_path: str | None
    mime_type: str
    width: int | None
    height: int | None
    created_at: str

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "job_id": self.job_id,
            "kind": self.kind,
            "file_path": self.file_path,
            "preview_path": self.preview_path,
            "mime_type": self.mime_type,
            "width": self.width,
            "height": self.height,
            "created_at": self.created_at,
        }


@dataclass
class ReferenceImage:
    id: str
    file_name: str
    file_path: str | None
    mime_type: str | None
    size_bytes: int | None
    extracted_text: str | None
    created_at: str

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "file_name": self.file_name,
            "file_path": self.file_path,
            "mime_type": self.mime_type,
            "size_bytes": self.size_bytes,
            "extracted_text": self.extracted_text,
            "created_at": self.created_at,
        }


@dataclass
class ImageJob:
    id: str
    prompt: str
    negative_prompt: str | None
    model: str
    backend: Literal["placeholder", "diffusers", "comfyui"]
    mode: Literal["text-to-image", "image-to-image"]
    workflow_profile: Literal["default", "qwen-image-edit-2511"]
    width: int
    height: int
    steps: int
    guidance_scale: float
    seed: int | None
    output_path: str
    reference_images: list[ReferenceImage]
    status: Literal["queued", "running", "completed", "failed", "cancelled"] = "queued"
    progress: float = 0.0
    stage: str | None = "Queued"
    error_message: str | None = None
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    started_at: str | None = None
    completed_at: str | None = None
    artifacts: list[JobArtifact] = field(default_factory=list)
    cancel_event: Event = field(default_factory=Event, repr=False)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "kind": "image",
            "mode": self.mode,
            "workflow_profile": self.workflow_profile,
            "status": self.status,
            "prompt": self.prompt,
            "negative_prompt": self.negative_prompt,
            "model": self.model,
            "backend": self.backend,
            "width": self.width,
            "height": self.height,
            "steps": self.steps,
            "guidance_scale": self.guidance_scale,
            "seed": self.seed,
            "progress": round(self.progress, 6),
            "stage": self.stage,
            "error_message": self.error_message,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "reference_images": [
                reference_image.to_dict() for reference_image in self.reference_images
            ],
            "artifacts": [artifact.to_dict() for artifact in self.artifacts],
        }


class JobQueue:
    """In-memory generation queue with observable status snapshots."""

    def __init__(self, state_file_path: str | Path | None = None) -> None:
        self._jobs: dict[str, ImageJob] = {}
        self._workers: dict[str, Thread] = {}
        self._lock = Lock()
        self._execution_lock = Lock()
        self._state_file_path = (
            None if state_file_path is None else Path(state_file_path)
        )

    def stats(self) -> dict[str, int]:
        with self._lock:
            pending_jobs = sum(job.status == "queued" for job in self._jobs.values())
            active_jobs = sum(job.status == "running" for job in self._jobs.values())
        return {
            "pending": pending_jobs,
            "active": active_jobs,
        }

    def list_jobs(self) -> list[dict[str, object]]:
        with self._lock:
            jobs = sorted(
                self._jobs.values(),
                key=lambda job: job.updated_at,
                reverse=True,
            )
            return [job.to_dict() for job in jobs]

    def get_job(self, job_id: str) -> dict[str, object] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return None if job is None else job.to_dict()

    def create_image_job(
        self,
        payload: dict[str, object],
        model_manager: ModelManager,
    ) -> dict[str, object]:
        job = ImageJob(
            id=str(payload["id"]),
            prompt=str(payload["prompt"]),
            negative_prompt=self._coerce_optional_text(payload.get("negative_prompt")),
            model=str(payload["model"]),
            backend=str(payload["backend"]),
            mode=str(payload["mode"]),
            workflow_profile=str(payload["workflow_profile"]),
            width=int(payload["width"]),
            height=int(payload["height"]),
            steps=int(payload["steps"]),
            guidance_scale=float(payload["guidance_scale"]),
            seed=self._coerce_optional_int(payload.get("seed")),
            output_path=str(payload["output_path"]),
            reference_images=self._coerce_reference_images(
                payload.get("reference_images")
            ),
        )

        with self._lock:
            self._jobs[job.id] = job
            self._persist_state_locked()

        worker = Thread(
            target=self._run_image_job,
            args=(job.id, model_manager),
            daemon=True,
        )
        with self._lock:
            self._workers[job.id] = worker
        worker.start()
        return job.to_dict()

    def restore_jobs(self, model_manager: ModelManager) -> int:
        restored_jobs = self._load_persisted_jobs()

        if not restored_jobs:
            return 0

        workers_to_start: list[Thread] = []
        restored_count = 0

        with self._lock:
            for job in restored_jobs:
                if job.id in self._jobs:
                    continue

                timestamp = now_iso()
                job.status = "queued"
                job.progress = 0.0
                job.stage = "Recovered after worker restart"
                job.error_message = None
                job.started_at = None
                job.completed_at = None
                job.updated_at = timestamp
                job.cancel_event = Event()
                self._jobs[job.id] = job

                worker = Thread(
                    target=self._run_image_job,
                    args=(job.id, model_manager),
                    daemon=True,
                )
                self._workers[job.id] = worker
                workers_to_start.append(worker)
                restored_count += 1

            self._persist_state_locked()

        for worker in workers_to_start:
            worker.start()

        return restored_count

    def cancel_job(self, job_id: str) -> dict[str, object] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None

            job.cancel_event.set()

            if job.status == "queued":
                timestamp = now_iso()
                job.status = "cancelled"
                job.progress = 0.0
                job.stage = "Cancelled"
                job.completed_at = timestamp
                job.updated_at = timestamp
                self._persist_state_locked()

            return job.to_dict()

    def _run_image_job(self, job_id: str, model_manager: ModelManager) -> None:
        acquired_execution_slot = False
        try:
            acquired_execution_slot = self._execution_lock.acquire(blocking=False)

            if not acquired_execution_slot:
                self._mark_waiting_for_execution(job_id)
                self._execution_lock.acquire()
                acquired_execution_slot = True

            if acquired_execution_slot:
                with self._lock:
                    job = self._jobs[job_id]

                    if job.cancel_event.is_set() or job.status == "cancelled":
                        return

                    timestamp = now_iso()
                    job.status = "running"
                    job.progress = 0.05
                    job.stage = "Starting"
                    job.started_at = timestamp
                    job.updated_at = timestamp
                    self._persist_state_locked()

                result = model_manager.generate_image(
                    ImageGenerationRequest(
                        prompt=job.prompt,
                        negative_prompt=job.negative_prompt,
                        model=job.model,
                        width=job.width,
                        height=job.height,
                        steps=job.steps,
                        guidance_scale=job.guidance_scale,
                        seed=job.seed,
                        output_path=job.output_path,
                        mode=job.mode,
                        workflow_profile=job.workflow_profile,
                        reference_images=job.reference_images,
                    ),
                    progress_callback=lambda progress, stage: self._update_progress(
                        job_id, progress, stage
                    ),
                    is_cancelled=lambda: self._is_cancelled(job_id),
                )

            if self._is_cancelled(job_id):
                self._mark_cancelled(job_id)
                return

            artifact = JobArtifact(
                id=str(uuid4()),
                job_id=job_id,
                kind="image",
                file_path=str(result["file_path"]),
                preview_path=(
                    str(result["preview_path"])
                    if result.get("preview_path") is not None
                    else str(result["file_path"])
                ),
                mime_type=str(result["mime_type"]),
                width=int(result["width"]) if result.get("width") is not None else None,
                height=int(result["height"]) if result.get("height") is not None else None,
                created_at=now_iso(),
            )
            self._mark_completed(job_id, artifact)
        except GenerationCancelledError:
            self._mark_cancelled(job_id)
        except Exception as error:
            self._mark_failed(job_id, str(error))
        finally:
            if acquired_execution_slot:
                self._execution_lock.release()

            with self._lock:
                self._workers.pop(job_id, None)

    def _mark_waiting_for_execution(self, job_id: str) -> None:
        if not self._execution_lock.locked():
            return

        with self._lock:
            job = self._jobs.get(job_id)

            if job is None or job.status != "queued" or job.cancel_event.is_set():
                return

            job.stage = "Waiting for GPU slot"
            job.updated_at = now_iso()
            self._persist_state_locked()

    def shutdown(
        self,
        model_manager: ModelManager,
        wait_timeout_seconds: float = 4.0,
    ) -> None:
        with self._lock:
            jobs = list(self._jobs.values())
            workers = list(self._workers.values())

            for job in jobs:
                if job.status in ("completed", "failed", "cancelled"):
                    continue

                job.cancel_event.set()

                if job.status == "queued":
                    timestamp = now_iso()
                    job.status = "cancelled"
                    job.progress = 0.0
                    job.stage = "Cancelled"
                    job.error_message = None
                    job.completed_at = timestamp
                    job.updated_at = timestamp

        if workers:
            per_worker_timeout = wait_timeout_seconds / max(len(workers), 1)

            for worker in workers:
                worker.join(timeout=max(0.0, per_worker_timeout))

        with self._lock:
            for job in self._jobs.values():
                if job.status in ("completed", "failed", "cancelled"):
                    continue

                timestamp = now_iso()
                job.status = "cancelled"
                job.stage = "Cancelled"
                job.error_message = None
                job.completed_at = timestamp
                job.updated_at = timestamp
                self._persist_state_locked()

        model_manager.shutdown()

    def _update_progress(self, job_id: str, progress: float, stage: str | None) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status not in ("queued", "running"):
                return

            job.progress = max(0.0, min(1.0, float(progress)))
            job.stage = stage
            job.updated_at = now_iso()

    def _mark_completed(self, job_id: str, artifact: JobArtifact) -> None:
        with self._lock:
            job = self._jobs[job_id]
            timestamp = now_iso()
            job.status = "completed"
            job.progress = 1.0
            job.stage = "Completed"
            job.error_message = None
            job.completed_at = timestamp
            job.updated_at = timestamp
            job.artifacts = [artifact]
            self._persist_state_locked()

    def _mark_cancelled(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            timestamp = now_iso()
            job.status = "cancelled"
            job.stage = "Cancelled"
            job.error_message = None
            job.completed_at = timestamp
            job.updated_at = timestamp
            self._persist_state_locked()

    def _mark_failed(self, job_id: str, error_message: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            timestamp = now_iso()
            job.status = "failed"
            job.stage = "Failed"
            job.error_message = error_message
            job.completed_at = timestamp
            job.updated_at = timestamp
            self._persist_state_locked()

    def _is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            return False if job is None else job.cancel_event.is_set()

    def _coerce_optional_text(self, value: object) -> str | None:
        if value is None:
            return None

        text = str(value).strip()
        return text or None

    def _coerce_optional_int(self, value: object) -> int | None:
        if value in (None, ""):
            return None
        return int(value)

    def _coerce_reference_images(self, value: object) -> list[ReferenceImage]:
        if not isinstance(value, list):
            return []

        reference_images: list[ReferenceImage] = []

        for item in value:
            if not isinstance(item, dict):
                continue

            reference_images.append(
                ReferenceImage(
                    id=str(item.get("id") or uuid4()),
                    file_name=str(item.get("file_name") or "reference-image"),
                    file_path=self._coerce_optional_text(item.get("file_path")),
                    mime_type=self._coerce_optional_text(item.get("mime_type")),
                    size_bytes=self._coerce_optional_int(item.get("size_bytes")),
                    extracted_text=self._coerce_optional_text(item.get("extracted_text")),
                    created_at=str(item.get("created_at") or now_iso()),
                )
            )

        return reference_images

    def _coerce_artifacts(self, value: object) -> list[JobArtifact]:
        if not isinstance(value, list):
            return []

        artifacts: list[JobArtifact] = []

        for item in value:
            if not isinstance(item, dict):
                continue

            artifacts.append(
                JobArtifact(
                    id=str(item.get("id") or uuid4()),
                    job_id=str(item.get("job_id") or ""),
                    kind="image",
                    file_path=str(item.get("file_path") or ""),
                    preview_path=self._coerce_optional_text(item.get("preview_path")),
                    mime_type=str(item.get("mime_type") or "image/png"),
                    width=self._coerce_optional_int(item.get("width")),
                    height=self._coerce_optional_int(item.get("height")),
                    created_at=str(item.get("created_at") or now_iso()),
                )
            )

        return artifacts

    def _persist_state_locked(self) -> None:
        if self._state_file_path is None:
            return

        active_jobs = [
            job.to_dict()
            for job in self._jobs.values()
            if job.status in ("queued", "running")
        ]

        if not active_jobs:
            self._remove_state_file()
            return

        try:
            self._state_file_path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = (
                self._state_file_path.parent / f"{self._state_file_path.name}.tmp"
            )
            temp_path.write_text(
                json.dumps(
                    {
                        "version": PERSISTED_QUEUE_STATE_VERSION,
                        "jobs": active_jobs,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            temp_path.replace(self._state_file_path)
        except Exception:
            return

    def _load_persisted_jobs(self) -> list[ImageJob]:
        if self._state_file_path is None or not self._state_file_path.exists():
            return []

        try:
            payload = json.loads(self._state_file_path.read_text(encoding="utf-8"))
        except Exception:
            self._remove_state_file()
            return []

        if not isinstance(payload, dict):
            self._remove_state_file()
            return []

        jobs = payload.get("jobs")

        if not isinstance(jobs, list):
            self._remove_state_file()
            return []

        restored_jobs: list[ImageJob] = []

        for item in jobs:
            if not isinstance(item, dict):
                continue

            if item.get("status") not in {"queued", "running"}:
                continue

            restored_jobs.append(
                ImageJob(
                    id=str(item.get("id") or uuid4()),
                    prompt=str(item.get("prompt") or ""),
                    negative_prompt=self._coerce_optional_text(
                        item.get("negative_prompt")
                    ),
                    model=str(item.get("model") or "builtin:placeholder"),
                    backend=str(item.get("backend") or "placeholder"),
                    mode=str(item.get("mode") or "text-to-image"),
                    workflow_profile=str(item.get("workflow_profile") or "default"),
                    width=int(item.get("width") or 512),
                    height=int(item.get("height") or 512),
                    steps=int(item.get("steps") or 4),
                    guidance_scale=float(
                        item["guidance_scale"]
                        if item.get("guidance_scale") is not None
                        else 4
                    ),
                    seed=self._coerce_optional_int(item.get("seed")),
                    output_path=str(item.get("output_path") or ""),
                    reference_images=self._coerce_reference_images(
                        item.get("reference_images")
                    ),
                    status=str(item.get("status") or "queued"),
                    progress=float(item.get("progress") or 0.0),
                    stage=self._coerce_optional_text(item.get("stage")),
                    error_message=self._coerce_optional_text(
                        item.get("error_message")
                    ),
                    created_at=str(item.get("created_at") or now_iso()),
                    updated_at=str(item.get("updated_at") or now_iso()),
                    started_at=self._coerce_optional_text(item.get("started_at")),
                    completed_at=self._coerce_optional_text(item.get("completed_at")),
                    artifacts=self._coerce_artifacts(item.get("artifacts")),
                )
            )

        return restored_jobs

    def _remove_state_file(self) -> None:
        if self._state_file_path is None:
            return

        try:
            self._state_file_path.unlink(missing_ok=True)
        except Exception:
            return
