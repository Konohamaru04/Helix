from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field


router = APIRouter(prefix="/jobs", tags=["generation"])


class StartImageJobRequest(BaseModel):
    id: str
    prompt: str = Field(min_length=1)
    negative_prompt: str | None = None
    model: str = Field(min_length=1)
    backend: str = Field(pattern="^(placeholder|diffusers|comfyui)$")
    mode: str = Field(pattern="^(text-to-image|image-to-image)$")
    workflow_profile: str = Field(pattern="^(default|qwen-image-edit-2511)$")
    width: int = Field(ge=256, le=2048)
    height: int = Field(ge=256, le=2048)
    steps: int = Field(ge=1, le=100)
    guidance_scale: float = Field(ge=0, le=50)
    seed: int | None = None
    output_path: str = Field(min_length=1)
    reference_images: list[dict[str, object]] = Field(default_factory=list, max_length=5)


class StartVideoJobRequest(BaseModel):
    id: str
    prompt: str = Field(min_length=1)
    negative_prompt: str | None = None
    model: str = Field(min_length=1)
    backend: str = Field(pattern="^comfyui$")
    mode: str = Field(pattern="^image-to-video$")
    workflow_profile: str = Field(pattern="^wan-image-to-video$")
    width: int = Field(ge=256, le=2048)
    height: int = Field(ge=256, le=2048)
    steps: int = Field(ge=1, le=100)
    guidance_scale: float = Field(ge=0, le=50)
    seed: int | None = None
    frame_count: int = Field(ge=1, le=241)
    frame_rate: float = Field(ge=1, le=120)
    output_path: str = Field(min_length=1)
    high_noise_model: str = Field(min_length=1)
    low_noise_model: str = Field(min_length=1)
    reference_images: list[dict[str, object]] = Field(min_length=1, max_length=1)


@router.get("")
async def list_jobs(request: Request) -> list[dict[str, object]]:
    return request.app.state.job_queue.list_jobs()


@router.get("/{job_id}")
async def get_job(request: Request, job_id: str) -> dict[str, object]:
    job = request.app.state.job_queue.get_job(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Generation job not found.")

    return job


@router.post("/images")
async def start_image_job(
    request: Request, payload: StartImageJobRequest
) -> dict[str, object]:
    return request.app.state.job_queue.create_image_job(
        payload.model_dump(),
        request.app.state.model_manager,
    )


@router.post("/videos")
async def start_video_job(
    request: Request, payload: StartVideoJobRequest
) -> dict[str, object]:
    return request.app.state.job_queue.create_video_job(
        payload.model_dump(),
        request.app.state.model_manager,
    )


@router.post("/{job_id}/cancel")
async def cancel_job(request: Request, job_id: str) -> dict[str, object]:
    job = request.app.state.job_queue.cancel_job(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Generation job not found.")

    return job
