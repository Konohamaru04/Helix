from __future__ import annotations

import json
from pathlib import Path
from threading import Event
from time import sleep

from inference_server.job_queue import JobQueue


def _image_job_payload(job_id: str, output_path: Path) -> dict[str, object]:
    return {
        "id": job_id,
        "prompt": "Generate a dramatic skyline",
        "negative_prompt": "",
        "model": "builtin:placeholder",
        "backend": "placeholder",
        "mode": "text-to-image",
        "workflow_profile": "default",
        "width": 512,
        "height": 512,
        "steps": 4,
        "guidance_scale": 4,
        "seed": 42,
        "output_path": str(output_path),
        "reference_images": [],
    }


def _video_job_payload(
    job_id: str,
    output_path: Path,
    start_image_path: Path,
    high_noise_model: Path,
    low_noise_model: Path,
) -> dict[str, object]:
    return {
        "id": job_id,
        "prompt": "Add a slow camera orbit",
        "negative_prompt": "static frame",
        "model": str(high_noise_model),
        "backend": "comfyui",
        "mode": "image-to-video",
        "workflow_profile": "wan-image-to-video",
        "width": 528,
        "height": 704,
        "steps": 8,
        "guidance_scale": 1,
        "seed": 42,
        "output_path": str(output_path),
        "reference_images": [
            {
                "id": "90000000-0000-4000-8000-000000000201",
                "file_name": start_image_path.name,
                "file_path": str(start_image_path),
                "mime_type": "image/png",
                "size_bytes": 3,
                "extracted_text": None,
                "created_at": "2026-04-23T00:00:00.000Z",
            }
        ],
        "frame_count": 81,
        "frame_rate": 16,
        "high_noise_model": str(high_noise_model),
        "low_noise_model": str(low_noise_model),
    }


def _wait_for_job_status(
    queue: JobQueue, job_id: str, expected_status: str, timeout_seconds: float = 1.5
) -> dict[str, object]:
    deadline = timeout_seconds / 0.05

    for _ in range(int(deadline)):
        job = queue.get_job(job_id)
        assert job is not None

        if job["status"] == expected_status:
            return job

        sleep(0.05)

    raise AssertionError(
        f"Job {job_id} did not reach {expected_status!r} within {timeout_seconds} seconds."
    )


class _BlockingPlaceholderManager:
    def __init__(self, started: Event, allow_finish: Event) -> None:
        self._started = started
        self._allow_finish = allow_finish

    def generate_image(self, request, progress_callback, is_cancelled):
        progress_callback(0.3, "Rendering placeholder image")
        self._started.set()
        assert self._allow_finish.wait(timeout=1.0)

        output_path = Path(request.output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"fake-image")

        return {
            "file_path": str(output_path),
            "preview_path": str(output_path),
            "mime_type": "image/png",
            "width": request.width,
            "height": request.height,
        }

    def shutdown(self) -> None:
        return


class _BlockingVideoManager:
    def __init__(self, started: Event, allow_finish: Event) -> None:
        self._started = started
        self._allow_finish = allow_finish

    def generate_video(self, request, progress_callback, is_cancelled):
        progress_callback(0.3, "Preparing embedded Wan 2.2 workflow")
        self._started.set()
        assert self._allow_finish.wait(timeout=1.0)

        output_path = Path(request.output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"fake-video")

        return {
            "file_path": str(output_path),
            "preview_path": None,
            "mime_type": "video/mp4",
            "width": request.width,
            "height": request.height,
        }

    def shutdown(self) -> None:
        return


def test_queue_state_file_tracks_active_jobs_and_cleans_up_after_completion(
    tmp_path: Path,
) -> None:
    state_file = tmp_path / "queue-state.json"
    output_path = tmp_path / "generated.png"
    started = Event()
    allow_finish = Event()
    queue = JobQueue(state_file)
    model_manager = _BlockingPlaceholderManager(started, allow_finish)

    queue.create_image_job(
        _image_job_payload("70000000-0000-4000-8000-000000000010", output_path),
        model_manager,
    )

    assert started.wait(timeout=1.0)
    assert state_file.exists()
    persisted_state = json.loads(state_file.read_text(encoding="utf-8"))
    persisted_jobs = persisted_state.get("jobs")
    assert isinstance(persisted_jobs, list)
    assert persisted_jobs[0]["id"] == "70000000-0000-4000-8000-000000000010"

    allow_finish.set()

    completed_job = _wait_for_job_status(
        queue, "70000000-0000-4000-8000-000000000010", "completed"
    )
    assert completed_job["artifacts"]
    assert not state_file.exists()


def test_restore_jobs_replays_persisted_running_jobs(tmp_path: Path) -> None:
    state_file = tmp_path / "queue-state.json"
    output_path = tmp_path / "replayed.png"
    started = Event()
    allow_finish = Event()
    model_manager = _BlockingPlaceholderManager(started, allow_finish)
    queue = JobQueue(state_file)

    state_file.write_text(
        json.dumps(
            {
                "version": 1,
                "jobs": [
                    {
                        **_image_job_payload(
                            "70000000-0000-4000-8000-000000000011", output_path
                        ),
                        "kind": "image",
                        "status": "running",
                        "progress": 0.55,
                        "stage": "Sampling step 3/4",
                        "error_message": None,
                        "created_at": "2026-04-09T00:00:00.000Z",
                        "updated_at": "2026-04-09T00:00:01.000Z",
                        "started_at": "2026-04-09T00:00:00.000Z",
                        "completed_at": None,
                        "artifacts": [],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    restored_count = queue.restore_jobs(model_manager)

    assert restored_count == 1
    assert started.wait(timeout=1.0)
    restored_snapshot = queue.get_job("70000000-0000-4000-8000-000000000011")
    assert restored_snapshot is not None
    assert restored_snapshot["status"] in {"queued", "running"}

    allow_finish.set()

    completed_job = _wait_for_job_status(
        queue, "70000000-0000-4000-8000-000000000011", "completed"
    )
    assert completed_job["artifacts"][0]["file_path"] == str(output_path)
    assert not state_file.exists()


def test_video_job_state_persists_frame_metadata_and_paired_wan_models(
    tmp_path: Path,
) -> None:
    state_file = tmp_path / "queue-state.json"
    output_path = tmp_path / "generated.mp4"
    start_image = tmp_path / "start.png"
    high_noise_model = tmp_path / "DasiwaWAN22I2V14BSynthseduction_q8High.gguf"
    low_noise_model = tmp_path / "DasiwaWAN22I2V14BSynthseduction_q8Low.gguf"
    started = Event()
    allow_finish = Event()
    queue = JobQueue(state_file)
    model_manager = _BlockingVideoManager(started, allow_finish)

    start_image.write_bytes(b"png")
    high_noise_model.write_text("high", encoding="utf-8")
    low_noise_model.write_text("low", encoding="utf-8")

    queue.create_video_job(
        _video_job_payload(
            "70000000-0000-4000-8000-000000000210",
            output_path,
            start_image,
            high_noise_model,
            low_noise_model,
        ),
        model_manager,
    )

    assert started.wait(timeout=1.0)
    persisted_state = json.loads(state_file.read_text(encoding="utf-8"))
    persisted_job = persisted_state["jobs"][0]
    assert persisted_job["kind"] == "video"
    assert persisted_job["frame_count"] == 81
    assert persisted_job["frame_rate"] == 16.0
    assert persisted_job["high_noise_model"] == str(high_noise_model)
    assert persisted_job["low_noise_model"] == str(low_noise_model)

    allow_finish.set()

    completed_job = _wait_for_job_status(
        queue, "70000000-0000-4000-8000-000000000210", "completed"
    )
    assert completed_job["artifacts"][0]["mime_type"] == "video/mp4"
    assert not state_file.exists()
