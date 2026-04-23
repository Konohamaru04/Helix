"""Exposes live per-node progress to the embedded runner via a small REST route.

ComfyUI only broadcasts per-step progress over WebSocket. The embedded runner
speaks HTTP, so this custom node hooks into the progress registry, records the
latest per-prompt snapshot in memory, and serves it under
``/api/ollama-desktop/progress/{prompt_id}``.
"""

from __future__ import annotations

import logging
import time
from threading import Lock
from typing import Any

from comfy_execution import progress as _progress_module
from comfy_execution.progress import ProgressHandler


LOGGER = logging.getLogger(__name__)

NODE_CLASS_MAPPINGS: dict[str, Any] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}


class _ProgressStore:
    """Thread-safe in-memory snapshot of per-prompt node progress."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._snapshots: dict[str, dict[str, dict[str, Any]]] = {}
        self._updated_at: dict[str, float] = {}

    def update(self, prompt_id: str, node_id: str, state: Any) -> None:
        node_state = state.get("state") if isinstance(state, dict) else None
        state_str = (
            node_state.value if hasattr(node_state, "value") else str(node_state or "")
        )
        value = float(state.get("value") or 0) if isinstance(state, dict) else 0.0
        max_value = float(state.get("max") or 1) if isinstance(state, dict) else 1.0

        if max_value <= 0:
            max_value = 1.0

        with self._lock:
            nodes = self._snapshots.setdefault(prompt_id, {})
            nodes[node_id] = {
                "value": value,
                "max": max_value,
                "state": state_str,
            }
            self._updated_at[prompt_id] = time.monotonic()

    def snapshot(self, prompt_id: str) -> dict[str, Any]:
        with self._lock:
            nodes = self._snapshots.get(prompt_id) or {}
            return {
                "prompt_id": prompt_id,
                "nodes": {node_id: dict(state) for node_id, state in nodes.items()},
                "updated_at": self._updated_at.get(prompt_id),
            }


class _JobProgressTrackerHandler(ProgressHandler):
    HANDLER_NAME = "ollama_desktop_tracker"

    def __init__(self, store: _ProgressStore) -> None:
        super().__init__(self.HANDLER_NAME)
        self._store = store

    def start_handler(self, node_id, state, prompt_id):
        self._store.update(prompt_id, node_id, state)

    def update_handler(
        self, node_id, value, max_value, state, prompt_id, image=None
    ):
        self._store.update(prompt_id, node_id, state)

    def finish_handler(self, node_id, state, prompt_id):
        self._store.update(prompt_id, node_id, state)


_store = _ProgressStore()


def _install_registry_hook() -> None:
    # Guard against double-patching on module reload.
    if getattr(_progress_module.reset_progress_state, "_ollama_desktop_patched", False):
        return

    original_reset = _progress_module.reset_progress_state

    def _patched_reset(prompt_id, dynprompt):
        original_reset(prompt_id, dynprompt)
        try:
            _progress_module.add_progress_handler(
                _JobProgressTrackerHandler(_store)
            )
        except Exception:
            LOGGER.debug(
                "Failed to attach ollama-desktop progress tracker", exc_info=True
            )

    _patched_reset._ollama_desktop_patched = True  # type: ignore[attr-defined]
    _progress_module.reset_progress_state = _patched_reset

    # ``execution.py`` pulls ``reset_progress_state`` in via ``from ... import``,
    # binding the original function into its own module namespace. Rebind there
    # too so the patched wrapper actually runs during prompt execution.
    try:
        import execution as _execution_module

        if getattr(_execution_module, "reset_progress_state", None) is original_reset:
            _execution_module.reset_progress_state = _patched_reset
    except Exception:
        LOGGER.debug(
            "Failed to rebind execution.reset_progress_state", exc_info=True
        )


def _register_http_route() -> None:
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        LOGGER.warning(
            "ollama-desktop progress tracker could not import server/aiohttp"
        )
        return

    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None) if instance is not None else None

    if routes is None:
        LOGGER.warning(
            "ollama-desktop progress tracker could not locate PromptServer routes"
        )
        return

    @routes.get("/api/ollama-desktop/progress/{prompt_id}")
    async def _progress_route(request):  # type: ignore[no-untyped-def]
        prompt_id = request.match_info.get("prompt_id") or ""
        return web.json_response(_store.snapshot(prompt_id))


_install_registry_hook()
_register_http_route()
