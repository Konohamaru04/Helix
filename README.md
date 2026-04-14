# Helix

Local-first desktop AI workbench by Abstergo, built with Electron, React, typed IPC, SQLite, and a managed Python inference server.

## Current milestone

Milestones 1 through 6.3 are complete.

Still planned:

- `6.4 Future generation surfaces`
- `7 MCP`
- `8 Polish and release hardening`

Milestones 4 and 5 now include:

- routed chat with follow-up-aware heuristics
- route traces, token usage, fallback visibility, and pin-to-memory controls in the transcript
- safe built-in tools for calculator, code running, file reading, workspace listing, workspace opening, workspace search, workspace knowledge search, and web search
- automatic skill activation for grounded answers, builder mode, debugger mode, reviewer mode, and stepwise reasoning
- automatic tool and skill routing in the bridge, with explicit directive support still available for advanced flows
- native Ollama `/api/chat` tool-calling support for the implemented capability surface so models can automatically choose local tools when needed
- tool trace rendering and source provenance rendering
- workspace knowledge import, chunking, local embeddings, hybrid retrieval, citation cards, and memory summarization/pruning
- connectable workspace folders for project-relative tool access
- transcript auto-scroll and bounded code-block rendering
- in-flight chat replies can be stopped from the composer without breaking the stream lifecycle
- permissioned agentic capability surfaces for tasks, schedules, worktrees, agent sessions, shell execution, file mutation, notebook edits, and audit logging

Milestone 6 progress today includes:

- managed FastAPI image-generation routes through the bundled `python_embeded` runtime
- persisted generation jobs and generated-image artifacts in SQLite
- shared-composer image mode with image jobs rendered directly inside the chat timeline
- normal chat submit in `Auto` mode can now auto-route image creation and image-edit prompts into inline generation jobs, including follow-up edits that reuse the latest generated image as the reference input
- typed IPC progress updates for queued, running, completed, failed, and cancelled jobs
- cancellation for image jobs from the queue
- ordered Python-worker shutdown on app exit, including job cancellation, model unload, VRAM cleanup, and embedded ComfyUI teardown
- image-generation settings now support an additional local models directory and discover compatible local diffusers directories and checkpoint files from roots such as `ComfyUI\models`
- image-generation settings now also discover GGUF checkpoints from ComfyUI-style `diffusion_models` roots, with Qwen Image text models and Qwen Image Edit 2511 GGUF checkpoints selectable from the same catalog
- the Qwen Image Edit 2511 flow now preserves workflow metadata, keeps reference attachments from the shared composer, and routes image-to-image jobs through a dedicated Qwen edit worker path with workflow-specific defaults
- Python worker status now includes loaded image backend and VRAM telemetry, surfaced in the status bar

Still pending after the current slice:

- video and audio generation jobs
- external MCP server config, connection management, tool manifests, and prompt sync
- release hardening

Terminology:

- Workspace: a project-style container that groups related chats and local knowledge
- Workspace folder: an optional local directory bound to a workspace so tools can resolve relative project paths safely
- Chat: one conversation thread inside a workspace

Current UI simplification:

- the sidebar is navigation-focused for workspaces, search, and chat history
- workspace actions stay inside the chat surface, with folder and docs controls now tucked into the composer gear menu beside the `+` button
- settings open from the primary header action instead of being duplicated in the status bar
- the composer no longer exposes manual tool or skill pickers; routing chooses them automatically when needed
- chat model selection defaults to `Auto`, which uses Settings to route between General, Coding, and Vision models per turn

Model routing:

- `Text backend` selects the provider for normal routed text chat turns
- `Ollama` remains the default local-first text backend
- `NVIDIA` uses the OpenAI-compatible NVIDIA chat API path and requires an API key in Settings
- `General (base)` handles normal conversation and is the fallback route
- `Coding` is used for code-heavy prompts such as HTML/CSS, debugging, and implementation tasks
- `Vision` is used for image attachments and multimodal prompts
- `Image Gen` is now active and drives the managed Python image worker
- `Image Gen` can use the built-in placeholder backend, discovered local diffusers models, supported Qwen GGUF image checkpoints, and the dedicated Qwen Image Edit 2511 workflow for reference-guided jobs
- in `Auto`, normal text prompts can create inline image jobs directly without switching the composer into image mode first
- `Video Gen` remains visible but disabled until later Milestone 6 slices
- the current NVIDIA slice is text-only; image attachment analysis and native tool-calling still stay on the Ollama path

Auto routing behavior:

- direct `/tool` and `@skill` directives always win
- ambiguous follow-ups can reuse the previous tool or skill
- model-assisted routing is the default product path for tool and skill selection
- the bridge can now auto-select safe workspace tools for file reads, file searches, folder listings, code execution, grounded knowledge lookups, and web lookups
- the bridge can now open safe workspace files like videos, images, PDFs, and folders with the system default app from prompts such as `play video.mp4` or `open docs/guide.pdf`
- the bridge can run dependency-free JavaScript snippets from prompts such as `Run this JavaScript: \`\`\`js ... \`\`\``
- the bridge can search the public web for latest/current prompts and return source-linked snippets
- the bridge can auto-select built-in skills for builder, debugger, reviewer, grounded, and stepwise response modes
- the bridge can also expose the broader Milestone 4.1 capability surface to Ollama-native tool calling, including `Agent`, `AskUserQuestion`, `Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash`, `PowerShell`, `Monitor`, `Task*`, `TodoWrite`, `Cron*`, `Enter/ExitPlanMode`, `Enter/ExitWorktree`, `NotebookEdit`, `LSP`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `SendMessage`, `Team*`, `Skill`, `ToolSearch`, and `WebFetch`
- when no tool or skill is needed, the turn stays as normal chat and uses the configured model roles

Milestone 4.1 is now implemented; [docs/tool-spike.md](docs/tool-spike.md) remains as the design record for that capability map and permission model.

Track progress in [docs/milestones.md](docs/milestones.md).

## Run locally

1. Install Node dependencies:

```powershell
npm install
```

2. Choose the text backend you want to use:
   - `Ollama`: ensure Ollama is running locally and at least one model is available.
   - `NVIDIA`: open Settings, switch `Text backend` to `NVIDIA`, and add a valid NVIDIA API key. The default base URL is `https://integrate.api.nvidia.com/v1`.

3. Ensure Python dependencies for the managed API are available in `python_embeded`.
   The app treats `python_embeded\python.exe` as the bundled self-contained runtime and launches the root-level `inference_server/` package from there.

4. Start the app:

```powershell
npm run dev
```

Use the Electron window that opens. The Vite localhost URL is only the renderer dev server and will not expose the desktop preload bridge in a normal browser.

## Build a Windows `.exe`

Create a runnable Windows desktop build:

```powershell
npm run package:win
```

Fast packaging smoke check without the final installer:

```powershell
npm run package:dir
```

Artifacts are written to `release/`. The app executable is `release/win-unpacked/Helix.exe`, and it should stay beside the rest of the generated `win-unpacked` folder contents.

Packaged builds resolve runtime assets such as `python_embeded/`, `inference_server/`, `comfyui_backend/`, and `skills/` from the Electron `resources/` directory, while logs and mutable runtime data live under Electron `userData`.

## Validation

```powershell
npm run verify
```

That runs:

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run test:python`
- `npm run build`

## Repository shape

The codebase is organized around strict layer boundaries:

- `renderer/`: React UI, Zustand state, presentational components
- `electron/`: main process, preload, IPC registration
- `bridge/`: orchestration, routing, tools, skills, RAG, SQLite access, Ollama client, Python lifecycle
- `inference_server/`: FastAPI bootstrap server
- `comfyui_backend/`: bundled ComfyUI sidecar tree
- `tests/`: node, renderer, and python coverage

See [docs/architecture.md](docs/architecture.md) for the implemented design.
