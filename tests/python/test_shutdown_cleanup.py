from __future__ import annotations

from threading import Event

from inference_server.job_queue import ImageJob, JobQueue
from inference_server.main import monitor_parent_process
from inference_server.model_manager import ModelManager


def build_job(job_id: str, status: str) -> ImageJob:
    return ImageJob(
        id=job_id,
        prompt="test",
        negative_prompt=None,
        model="builtin:placeholder",
        backend="placeholder",
        mode="text-to-image",
        workflow_profile="default",
        width=512,
        height=512,
        steps=4,
        guidance_scale=1.0,
        seed=None,
        output_path="output.png",
        reference_images=[],
        status=status,
    )


def test_model_manager_shutdown_unloads_pipeline_and_stops_embedded_comfyui() -> None:
    manager = ModelManager()
    soft_empty_cache_called = Event()
    comfyui_shutdown_called = Event()

    manager.loaded_model = "model"
    manager.loaded_backend = "diffusers"
    manager.last_error = "previous error"
    manager._pipeline = object()
    manager._pipeline_key = "pipeline-key"
    manager._soft_empty_cache = lambda: soft_empty_cache_called.set()
    manager._comfyui_runner = type(
        "FakeComfyUIRunner",
        (),
        {"shutdown": staticmethod(lambda: comfyui_shutdown_called.set())},
    )()

    manager.shutdown()

    assert manager.loaded_model is None
    assert manager.loaded_backend is None
    assert manager.last_error is None
    assert manager._pipeline is None
    assert manager._pipeline_key is None
    assert soft_empty_cache_called.is_set()
    assert comfyui_shutdown_called.is_set()


def test_job_queue_shutdown_cancels_jobs_and_unloads_models() -> None:
    queue = JobQueue()
    shutdown_called = Event()
    queued_job = build_job("queued-job", "queued")
    running_job = build_job("running-job", "running")

    queue._jobs[queued_job.id] = queued_job
    queue._jobs[running_job.id] = running_job

    fake_manager = type(
        "FakeModelManager",
        (),
        {"shutdown": staticmethod(lambda: shutdown_called.set())},
    )()

    queue.shutdown(fake_manager, wait_timeout_seconds=0.01)

    queued_snapshot = queue.get_job(queued_job.id)
    running_snapshot = queue.get_job(running_job.id)

    assert queued_snapshot is not None
    assert running_snapshot is not None
    assert queued_snapshot["status"] == "cancelled"
    assert running_snapshot["status"] == "cancelled"
    assert queued_job.cancel_event.is_set()
    assert running_job.cancel_event.is_set()
    assert shutdown_called.is_set()


def test_monitor_parent_process_triggers_shutdown_when_parent_exits() -> None:
    sleep_calls: list[float] = []
    shutdown_called = Event()
    checks = iter([True, True, False])

    monitor_parent_process(
        1234,
        on_parent_exit=lambda: shutdown_called.set(),
        process_alive=lambda _pid: next(checks),
        sleep_interval_seconds=0.5,
        sleep_fn=lambda seconds: sleep_calls.append(seconds),
    )

    assert shutdown_called.is_set()
    assert sleep_calls == [0.5, 0.5]
