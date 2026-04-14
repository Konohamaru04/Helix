from collections.abc import Callable
from contextlib import asynccontextmanager
import os
from pathlib import Path
from threading import Thread
import tempfile
import time

from fastapi import FastAPI

from .job_queue import JobQueue
from .model_manager import ModelManager
from .routes.generation import router as generation_router
from .routes.health import router as health_router


QUEUE_STATE_FILE_NAME = "generation-queue-state.json"


def is_process_alive(pid: int) -> bool:
    if pid <= 0:
        return False

    if os.name == "nt":
        import ctypes

        access = 0x00100000 | 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(access, False, pid)

        if not handle:
            return False

        try:
            wait_timeout = 0x00000102
            return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == wait_timeout
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except OSError:
        return False

    return True


def shutdown_runtime(app: FastAPI) -> None:
    app.state.job_queue.shutdown(app.state.model_manager)


def monitor_parent_process(
    parent_pid: int,
    *,
    on_parent_exit: Callable[[], None],
    process_alive: Callable[[int], bool] = is_process_alive,
    sleep_interval_seconds: float = 1.0,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> None:
    while process_alive(parent_pid):
        sleep_fn(sleep_interval_seconds)

    on_parent_exit()


def _shutdown_and_exit(app: FastAPI) -> None:
    try:
        shutdown_runtime(app)
    finally:
        os._exit(0)


def start_parent_watchdog(app: FastAPI) -> Thread | None:
    raw_parent_pid = os.getenv("OLLAMA_DESKTOP_PARENT_PID")

    if raw_parent_pid is None:
        return None

    try:
        parent_pid = int(raw_parent_pid)
    except ValueError:
        return None

    if parent_pid <= 0:
        return None

    watchdog = Thread(
        target=monitor_parent_process,
        kwargs={
            "parent_pid": parent_pid,
            "on_parent_exit": lambda: _shutdown_and_exit(app),
        },
        daemon=True,
        name="ollama-desktop-parent-watchdog",
    )
    watchdog.start()
    return watchdog


def resolve_worker_state_directory() -> Path:
    configured_directory = os.getenv("OLLAMA_DESKTOP_PYTHON_STATE_DIR")

    if configured_directory:
        return Path(configured_directory)

    return Path(tempfile.gettempdir()) / "ollama-desktop-python-worker"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.model_manager = ModelManager()
    state_directory = resolve_worker_state_directory()
    app.state.job_queue = JobQueue(state_directory / QUEUE_STATE_FILE_NAME)
    app.state.job_queue.restore_jobs(app.state.model_manager)
    app.state.parent_watchdog = start_parent_watchdog(app)
    try:
        yield
    finally:
        shutdown_runtime(app)


app = FastAPI(
    title="Forge Inference Server",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(generation_router)


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "forge-inference-server",
        "status": "ok",
    }
