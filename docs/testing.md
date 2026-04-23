# Testing

## Commands

Node and renderer:

```powershell
npm run test
```

Python smoke tests:

```powershell
npm run test:python
```

Full verification:

```powershell
npm run verify
```

Manual prompt benchmark suite:

- see [benchmark-prompts.md](./benchmark-prompts.md) for a manual benchmark catalog covering tools, skills, image analysis, image generation, and image editing

## Current coverage

The current suite covers:

- SQLite initialization and numbered migrations
- workspace bootstrap and FTS5-backed conversation search
- markdown export and import round-trip with attachment metadata
- context assembly trimming, prompt layering, pinned memory provenance, and source dedupe
- routing precedence, follow-up carry-forward, direct tool routing, and tool-assisted routing
- routing selection across General, Coding, Vision, auto mode, and fallback behavior
- selected general-chat models still yield to specialist Coding or Vision routing when the prompt clearly requires that capability
- routing to the new code-runner and web-search tools for explicit runnable/current prompts
- native Ollama tool-calling for both built-in tools and capability-backed Milestone 4.1 tools such as `task-create`
- automatic builder, debugger, reviewer, and grounded skill activation
- safe calculator validation, code-runner sandbox behavior, workspace lister/search behavior, knowledge search behavior, web-search behavior, and file-reader boundaries
- capability permission enforcement, audit-event recording, JSON-shaped capability inputs, richer `tool-search` discovery, and persisted task/schedule state
- safe workspace opener behavior for videos, documents, and folders, including executable blocking
- natural-language workspace lister prompts like "list all the files in this directory" and nested folder extraction such as `src/components`
- corrective workspace-tool follow-ups like `E:\Project is the correct directory` that should reuse the same tool route with the new path instead of falling back to plain chat
- connected workspace-folder validation and duplicate-root protection
- workspace knowledge import, dedupe, local embedding persistence, typo-tolerant hybrid retrieval, and memory summarization/pruning
- multimodal Ollama image payload generation for raster attachments
- renderer prompt submission through the preload bridge
- settings-drawer role configuration and image/video generation slot behavior
- single Settings entrypoint in the main chat surface
- composer keyboard behavior for `Enter` vs `Shift+Enter`
- transcript auto-scroll behavior when the user is at or away from the bottom
- automatic composer routing copy with no manual tool or skill picker buttons
- attachment picking and send payloads
- edit-resend and regenerate chat actions
- workspace-folder connect flow and workspace-doc import from the composer workspace menu through the preload bridge and Zustand store
- post-stream metadata rehydration in the app store
- graceful chat cancellation with partial-content preservation
- generation job persistence, completion polling, orphaned-job reconciliation, and cancellation metadata preservation
- generation preflight rejection for unsupported discovered models and clearly impossible worker states before queue persistence
- local image-model discovery from additional models directories, including ComfyUI-style diffusers/checkpoint layouts and GGUF discovery from `diffusion_models`
- GGUF model surfacing rules, including selectable Qwen Image text checkpoints, selectable Qwen Image Edit 2511 workflow checkpoints, and disabled video GGUF families
- workflow-aware generation payloads that preserve mode, workflow profile, reference-image metadata, and Wan frame/high-noise/low-noise settings across SQLite persistence and Python transport
- attached-image analysis prompts continue through chat and multimodal Vision routing after exiting image mode, instead of incorrectly starting image generation
- image-prompt authoring requests such as `create an image generation prompt for the same clothing` stay on the chat path instead of auto-starting image generation
- immediate submit feedback while bridge-side routing/classification starts, including duplicate-send suppression during the pre-stream startup window
- attachment reuse across message sends and edits without SQLite primary-key collisions in `message_attachments`
- restore-style image-edit follow-ups such as `change it back to original` carry both the current edited image and the earlier original reference image into the next generation request
- deleting an active conversation removes its conversation-scoped inline image jobs from the visible transcript state immediately
- renderer retry flows for failed or cancelled image jobs in both the transcript and the shared queue drawer
- Python model-loader selection between diffusers directories, single-file checkpoints, supported Qwen Image GGUF checkpoints, Qwen Image Edit 2511 workflow pipelines, unsupported GGUF families, and missing local paths
- Python runtime eviction rules across diffusers and embedded ComfyUI, plus single-slot generation queue behavior for GPU-bound jobs
- Python queue-state persistence and replay inside the worker after an interrupted runtime, including Wan video frame metadata
- FastAPI Wan image-to-video route smoke tests and embedded ComfyUI asset validation for paired high-noise/low-noise checkpoints
- summarized-memory injection into live Ollama prompt assembly for long conversations
- assistant Markdown, thinking blocks, tool traces, and source rendering
- FastAPI health route smoke test with VRAM visibility
- FastAPI image-generation job start, completion, artifact persistence, and cancellation smoke tests
- Python-worker shutdown coverage for queue cancellation, model unload, embedded ComfyUI teardown, and parent-process watchdog behavior
- deferred Python runtime manifest validation and requirements parsing for the first-run package provisioner

## Current test shape

- `tests/node/`: bridge, router, repository, tool, and RAG coverage
- `tests/renderer/`: store and component interaction coverage
- `tests/python/`: managed FastAPI smoke coverage for health and generation jobs

Manual packaged-runtime validation:

- run `npm run package:dir_win` or `npm run package:win` so the deferred packages are stripped from `python_embeded/` before packaging
- delete Electron `userData/python-runtime/`
- launch the packaged app
- confirm the splash reports the package check/install flow before the Python server starts
- confirm the main window only opens after provisioning completes

## Remaining gaps

These are still pending:

- end-to-end Electron window smoke tests
- end-to-end Electron generation job smoke tests
- external MCP connection, discovery, resource, and prompt tests
- inline approval-prompt renderer tests for risky capability actions
