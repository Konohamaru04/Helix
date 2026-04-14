from __future__ import annotations

from pathlib import Path
from threading import Event
from time import sleep

from fastapi.testclient import TestClient

from inference_server.main import app
from inference_server.model_manager import (
    GenerationCancelledError,
)


def _wait_for_terminal_job(client: TestClient, job_id: str) -> dict[str, object]:
    for _ in range(40):
        response = client.get(f"/jobs/{job_id}")
        assert response.status_code == 200
        payload = response.json()

        if payload["status"] in {"completed", "failed", "cancelled"}:
            return payload

        sleep(0.05)

    raise AssertionError(f"Job {job_id} did not reach a terminal state in time.")


def test_health_route_reports_queue_model_state_and_vram() -> None:
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["model_manager"]["loaded_model"] is None
    assert payload["queue"] == {"pending": 0, "active": 0}
    assert payload["vram"]["cuda_available"] in {True, False}
    assert "device" in payload["vram"]


def test_placeholder_image_job_completes_and_persists_an_artifact(tmp_path: Path) -> None:
    output_path = tmp_path / "placeholder-job.png"

    with TestClient(app) as client:
        response = client.post(
            "/jobs/images",
            json={
                "id": "70000000-0000-4000-8000-000000000001",
                "prompt": "A cinematic sunset skyline",
                "negative_prompt": "",
                "model": "builtin:placeholder",
                "backend": "placeholder",
                "mode": "text-to-image",
                "workflow_profile": "default",
                "width": 512,
                "height": 512,
                "steps": 4,
                "guidance_scale": 4,
                "seed": 123,
                "output_path": str(output_path),
                "reference_images": [],
            },
        )

        assert response.status_code == 200
        started_job = response.json()
        assert started_job["status"] in {"queued", "running"}

        completed_job = _wait_for_terminal_job(client, started_job["id"])

    assert completed_job["status"] == "completed"
    assert completed_job["artifacts"]
    artifact = completed_job["artifacts"][0]
    assert artifact["mime_type"] == "image/png"
    assert artifact["file_path"] == str(output_path)
    assert output_path.exists()
    assert output_path.stat().st_size > 0


def test_cancelling_image_job_marks_it_cancelled(tmp_path: Path, monkeypatch) -> None:
    output_path = tmp_path / "cancelled-job.png"

    with TestClient(app) as client:
        model_manager = client.app.state.model_manager

        def slow_generate_image(request, progress_callback, is_cancelled):
            progress_callback(0.1, "Starting")

            for _ in range(20):
                if is_cancelled():
                    raise GenerationCancelledError("Image generation was cancelled.")

                sleep(0.05)

            raise AssertionError("The job should have been cancelled before finishing.")

        monkeypatch.setattr(model_manager, "generate_image", slow_generate_image)

        response = client.post(
            "/jobs/images",
            json={
                "id": "70000000-0000-4000-8000-000000000002",
                "prompt": "A portrait study",
                "negative_prompt": "",
                "model": "builtin:placeholder",
                "backend": "placeholder",
                "mode": "text-to-image",
                "workflow_profile": "default",
                "width": 512,
                "height": 512,
                "steps": 4,
                "guidance_scale": 4,
                "seed": 456,
                "output_path": str(output_path),
                "reference_images": [],
            },
        )

        assert response.status_code == 200
        started_job = response.json()

        cancel_response = client.post(f"/jobs/{started_job['id']}/cancel")
        assert cancel_response.status_code == 200

        cancelled_job = _wait_for_terminal_job(client, started_job["id"])

    assert cancelled_job["status"] == "cancelled"
    assert cancelled_job["stage"] == "Cancelled"
    assert cancelled_job["error_message"] is None


def test_second_image_job_waits_for_the_single_gpu_execution_slot(
    tmp_path: Path, monkeypatch
) -> None:
    first_started = Event()
    allow_first_to_finish = Event()
    second_started = Event()

    with TestClient(app) as client:
        model_manager = client.app.state.model_manager

        def serialized_generate_image(request, progress_callback, is_cancelled):
            output_path = Path(request.output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake-image")

            if request.prompt == "first job":
                first_started.set()
                progress_callback(0.2, "Running first job")
                assert allow_first_to_finish.wait(timeout=1.0)
            else:
                second_started.set()
                progress_callback(0.2, "Running second job")

            return {
                "file_path": str(output_path),
                "preview_path": str(output_path),
                "mime_type": "image/png",
                "width": request.width,
                "height": request.height,
            }

        monkeypatch.setattr(model_manager, "generate_image", serialized_generate_image)

        first_response = client.post(
            "/jobs/images",
            json={
                "id": "70000000-0000-4000-8000-000000000003",
                "prompt": "first job",
                "negative_prompt": "",
                "model": "builtin:placeholder",
                "backend": "placeholder",
                "mode": "text-to-image",
                "workflow_profile": "default",
                "width": 512,
                "height": 512,
                "steps": 4,
                "guidance_scale": 4,
                "seed": 111,
                "output_path": str(tmp_path / "first.png"),
                "reference_images": [],
            },
        )
        assert first_response.status_code == 200

        second_response = client.post(
            "/jobs/images",
            json={
                "id": "70000000-0000-4000-8000-000000000004",
                "prompt": "second job",
                "negative_prompt": "",
                "model": "builtin:placeholder",
                "backend": "placeholder",
                "mode": "text-to-image",
                "workflow_profile": "default",
                "width": 512,
                "height": 512,
                "steps": 4,
                "guidance_scale": 4,
                "seed": 222,
                "output_path": str(tmp_path / "second.png"),
                "reference_images": [],
            },
        )
        assert second_response.status_code == 200

        assert first_started.wait(timeout=1.0)
        sleep(0.1)

        second_snapshot = client.get("/jobs/70000000-0000-4000-8000-000000000004")
        assert second_snapshot.status_code == 200
        second_job = second_snapshot.json()
        assert second_job["status"] == "queued"
        assert second_job["stage"] == "Waiting for GPU slot"
        assert not second_started.is_set()

        allow_first_to_finish.set()

        first_completed = _wait_for_terminal_job(
            client, "70000000-0000-4000-8000-000000000003"
        )
        second_completed = _wait_for_terminal_job(
            client, "70000000-0000-4000-8000-000000000004"
        )

    assert first_completed["status"] == "completed"
    assert second_completed["status"] == "completed"
    assert second_started.is_set()
