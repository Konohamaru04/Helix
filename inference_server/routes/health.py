import os
from threading import Thread
import time

from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request) -> dict[str, object]:
    model_manager = request.app.state.model_manager
    job_queue = request.app.state.job_queue

    return {
        "status": "ok",
        "model_manager": model_manager.status(),
        "vram": model_manager.estimate_vram(),
        "queue": job_queue.stats(),
    }


@router.post("/shutdown")
async def shutdown(request: Request) -> dict[str, str]:
    model_manager = request.app.state.model_manager
    job_queue = request.app.state.job_queue

    def perform_shutdown() -> None:
        try:
            job_queue.shutdown(model_manager)
        finally:
            time.sleep(0.2)
            os._exit(0)

    Thread(target=perform_shutdown, daemon=True).start()
    return {
        "status": "shutting-down",
    }
