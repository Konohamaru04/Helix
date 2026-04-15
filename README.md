# Helix

**Local-first desktop AI workbench** — built with Electron, React, SQLite, and a managed Python inference server.

Helix runs entirely on your machine. Chat with local Ollama models or NVIDIA-hosted models, use a full agentic tool surface, retrieve from your own knowledge base, and generate images — all without sending your data to a third-party service unless you opt in.

---

## Features

### Chat

- Multi-workspace, multi-conversation chat with full SQLite history and FTS5 full-text search
- Streaming replies with buffered rendering so fast models don't flicker
- `<think>…</think>` blocks parsed and collapsed into expandable reasoning sections
- Token usage, route trace, fallback visibility, and pin-to-memory controls per turn
- Edit and resend last user message; regenerate or retry last assistant response
- Stop in-flight replies without breaking the stream lifecycle
- Attachment previews in the composer and transcript (images, files)
- Import and export conversations through the bridge

### Routing

The bridge classifies every turn and picks a strategy from: `chat`, `skill-chat`, `tool`, `tool-chat`, `rag-chat`, `rag-tool`.

Priority order:
1. Explicit `/tool` directive
2. Explicit `@skill` directive
3. Model-assisted analysis (when confidence ≥ 0.55)
4. Heuristic intent detection
5. Follow-up carry-forward from the previous turn
6. Plain chat

Model roles per turn (configured in Settings):
- **General** — default conversation and fallback
- **Coding** — code-heavy prompts detected by heuristic or model analysis
- **Vision** — image attachments or multimodal prompts

### Tools

Built-in heuristic-routed tools:

| Tool | Trigger |
|---|---|
| `calculator` | Math expressions, compute/evaluate/what-is |
| `code-runner` | Run/execute + JS code block or `javascript` keyword |
| `file-reader` | Read/show/summarize + file path |
| `workspace-lister` | `ls`, `dir`, list/show + files/folders/tree |
| `workspace-search` | Find/search/locate + function/component/class/file |
| `workspace-opener` | Open/play/launch + file or folder target |
| `knowledge-search` | Search/cite + doc/knowledge/manual |
| `web-search` | "search the web", latest/current + search |

Agentic tool surface (exposed to Ollama native tool calling):
`Agent`, `AskUserQuestion`, `SendMessage`, `Read`, `Glob`, `Grep`, `Write`, `Edit`, `NotebookEdit`, `Bash`, `PowerShell`, `Monitor`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`, `TodoWrite`, `CronCreate`, `CronDelete`, `CronList`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `LSP`, `ToolSearch`, `WebFetch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `Skill`, `TeamCreate`, `TeamDelete`

Permissions are grant-stored in SQLite with a full audit log. The renderer exposes a capability settings UI.

### Skills

Five built-in Markdown-driven skills, auto-activated by intent:

| Skill | Auto-trigger |
|---|---|
| `grounded` | cite/source/reference + workspace has knowledge |
| `reviewer` | review/audit/inspect/code review |
| `debugger` | debug/fix/broken/error/exception |
| `stepwise` | step-by-step/steps/plan/walk me through |
| `builder` | create/build/implement + code intent |

User-defined skills go in `skills/user/`.

### RAG & Memory

- Document ingestion with text chunking
- Local 96-dim hash-based embeddings (no external model required)
- Hybrid FTS5 + semantic retrieval, configurable per workspace
- Citation cards and source provenance in the transcript
- Conversation memory summarization and pruning; pinned messages survive summarization

### Image Generation

Managed FastAPI worker launched from `python_embeded\python.exe`:

| Backend | Model source | Load strategy |
|---|---|---|
| `builtin:placeholder` | Built-in smoke test backend | — |
| `diffusers` | Local directory with `model_index.json` | `diffusers-directory` |
| `diffusers` | `.safetensors`/`.ckpt`/`.pt`/`.pth` checkpoint | `diffusers-single-file` |
| `diffusers` | GGUF Qwen Image (text-to-image) | `diffusers-gguf` |
| `comfyui` | GGUF Qwen Image Edit (image-to-image) | `comfyui-workflow` |

GGUF architecture is sniffed from file headers (`qwen_image`, `wan`, `flux`). Wan and FLUX families are discovered but gated — not yet enabled.

`Auto` chat submit routes image creation and follow-up edit prompts directly to inline generation jobs. The `Auto` flow reuses the latest generated image as the reference input for edit follow-ups.

GPU headroom is enforced before loading models. The Python worker persists queued and running jobs to a restart-safe state file and replays them on boot. Desktop notifications fire on job completion and failure. Failed jobs can be retried from the chat timeline or the queue drawer.

### Workspaces

- Workspace folders bind a local directory for project-relative tool access
- Per-workspace knowledge base — import, chunk, index, retrieve
- Workspace prompt, skills, pinned memory, and RAG chunks assembled in a deterministic order per turn

---

## Tech Stack

| | |
|---|---|
| Shell | Electron 41 |
| Renderer | React 19, TypeScript 6, Tailwind CSS 3 |
| Build | electron-vite, Vite 7 |
| State | Zustand 5 |
| Schema validation | Zod 4 |
| Persistence | SQLite (WAL, FK enforced) — 13 numbered migrations |
| Logging | Pino (structured, main process) |
| Testing | Vitest, @testing-library/react, pytest |
| Text inference | Ollama (local REST + streaming), NVIDIA OpenAI-compatible API |
| Image inference | FastAPI + diffusers + ComfyUI (managed child process) |
| Python runtime | Bundled `python_embeded\python.exe` |

---

## Repository Structure

```
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── tsconfig.base.json
├── tsconfig.node.json
├── tsconfig.renderer.json
├── vitest.config.ts
├── tailwind.config.ts
├── postcss.config.cjs
├── eslint.config.mjs
├── pytest.ini
│
├── renderer/
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx
│   ├── styles.css
│   ├── components/
│   ├── pages/
│   ├── store/
│   ├── hooks/
│   └── lib/
│
├── electron/
│   ├── main.ts
│   ├── preload.ts
│   └── ipc/
│
├── bridge/
│   ├── app-context.ts
│   ├── branding.ts
│   ├── router.ts
│   ├── context.ts
│   ├── jsonish.ts
│   ├── path-prompt.ts
│   ├── rag.ts
│   ├── embeddings.ts
│   ├── memory.ts
│   ├── queue.ts
│   ├── chat/
│   ├── tools/
│   ├── capabilities/
│   ├── skills/
│   ├── generation/
│   ├── ollama/
│   ├── python/
│   ├── mcp/
│   ├── db/
│   ├── settings/
│   ├── nvidia/
│   ├── ipc/
│   └── logging/
│
├── inference_server/
├── comfyui_backend/
├── python_embeded/
│
├── skills/
│   ├── builtin/
│   └── user/
│
├── knowledge/
│
├── tests/
│   ├── node/
│   ├── renderer/
│   └── python/
│
└── docs/
```

### Root

| File | Description |
|------|-------------|
| `package.json` | Dependencies + npm scripts |
| `electron.vite.config.ts` | Vite + Electron build config; defines `@bridge`, `@electron`, `@renderer` path aliases |
| `electron-builder.yml` | Electron packaging + installer config |
| `tsconfig.json` | Root TypeScript config |
| `tsconfig.base.json` | Shared TS base (extended by node + renderer configs) |
| `tsconfig.node.json` | Main process TS config |
| `tsconfig.renderer.json` | Renderer TS config |
| `vitest.config.ts` | Vitest test runner config |
| `tailwind.config.ts` | Tailwind CSS config |
| `postcss.config.cjs` | PostCSS config |
| `eslint.config.mjs` | ESLint config |
| `pytest.ini` | Python test config |

### `renderer/`

| Path | Description |
|------|-------------|
| `index.html` | HTML shell |
| `main.tsx` | Renderer entry point |
| `App.tsx` | Root React component |
| `styles.css` | Global styles |
| `components/` | attachment-card, chat-composer, desktop-only-notice, generation-job-card, generation-thread-item, message-bubble, message-list, plan-drawer, queue-drawer, settings-drawer, sidebar, status-bar |
| `pages/chat-page.tsx` | Main chat page |
| `store/app-store.ts` | Zustand store |
| `hooks/use-app-bootstrap.ts` | App bootstrap hook |
| `lib/api.ts` | Renderer-side API helpers |
| `lib/attachments.ts` | Attachment utilities |
| `lib/format.ts` | Formatting utilities |
| `lib/image-generation-models.ts` | Image model helpers |
| `lib/message-content.ts` | Message content utilities |

### `electron/`

| Path | Description |
|------|-------------|
| `main.ts` | App entry — BrowserWindow, IPC registration, process lifecycle |
| `preload.ts` | Typed bridge API exposed to renderer via contextBridge |
| `ipc/register-handlers.ts` | IPC handler registrations |

### `bridge/`

| Path | Description |
|------|-------------|
| `app-context.ts` | Wires all services together; single source of service instances |
| `branding.ts` | `APP_DISPLAY_NAME = 'Helix'` + package/company constants |
| `router.ts` | Intent classifier + model routing (chat, skill-chat, tool, rag-chat…) |
| `context.ts` | Context assembly in prompt order |
| `jsonish.ts` | Loose JSON parsing (`parseLooseJson`, `asRecord` helpers) |
| `path-prompt.ts` | Regex-based path token extraction from prompts |
| `rag.ts` | Chunking + hybrid FTS5/semantic retrieval |
| `embeddings.ts` | Local 96-dim hash-based embedding model (no external deps) |
| `memory.ts` | Conversation memory summarization + pruning |
| `queue.ts` | Generation job queue |
| `chat/` | `service.ts`, `repository.ts`, `turn-metadata.ts`, `attachment-utils.ts` |
| `tools/` | `index.ts` (schemas + dispatch), `code-runner.ts`, `web-search.ts` |
| `capabilities/` | `index.ts` (type defs), `repository.ts`, `service.ts` |
| `skills/index.ts` | Skill loader — reads Markdown from `skills/builtin/` + `skills/user/` |
| `generation/` | `service.ts`, `catalog.ts`, `repository.ts` |
| `ollama/client.ts` | OllamaClient — REST + streaming + native tool-call loop |
| `python/lifecycle.ts` | PythonServerManager child process lifecycle |
| `mcp/index.ts` | MCP surface wiring |
| `db/` | `database.ts`, `migrations/`, `sql-raw.d.ts` |
| `settings/service.ts` | SettingsService |
| `nvidia/catalog.ts` | NVIDIA model catalog helpers |
| `nvidia/client.ts` | NvidiaClient — GPU status detection, model listing |
| `ipc/contracts.ts` | Zod schemas for all typed IPC payloads |
| `logging/logger.ts` | Pino structured logger |

### Other

| Path | Description |
|------|-------------|
| `inference_server/` | FastAPI image-generation server (`/generation`, `/health`) |
| `comfyui_backend/` | ComfyUI integration (`job_queue.py`, `model_manager.py`, `comfyui_runner.py`) |
| `python_embeded/` | Bundled self-contained Python runtime (`python.exe`) — contents gitignored (binary, not source-tracked) |
| `skills/builtin/` | Built-in skills: grounded, builder, debugger, reviewer, stepwise |
| `skills/user/` | User-defined skill Markdown files |
| `knowledge/` | Knowledge base files for RAG ingestion |
| `tests/node/` | Node-side Vitest tests |
| `tests/renderer/` | Renderer-side Vitest + @testing-library tests |
| `tests/python/` | pytest tests |
| `docs/` | architecture.md, decisions.md, milestones.md, security.md, testing.md, tool-spike.md, mcp.md |

---

## Getting Started

### Prerequisites

- Node.js 20+
- One of:
  - **Ollama** running locally with at least one model pulled
  - **NVIDIA API key** for the cloud text backend
- `python_embeded\python.exe` with inference server dependencies (bundled in packaged builds; required manually for dev)

### Run in development

```bash
npm install
npm run dev
```

Open the Electron window. The Vite dev server URL printed in the terminal is the renderer dev server only — it does not expose the preload bridge in a browser.

### Configure text backend

Open **Settings** in the app header.

| Backend | What to set |
|---|---|
| **Ollama** (default) | Ensure Ollama is running. Default URL: `http://127.0.0.1:11434` |
| **NVIDIA** | Switch `Text backend` to `NVIDIA`. Add API key. Default URL: `https://integrate.api.nvidia.com/v1` |

Set **General**, **Coding**, and **Vision** model slots to the models you have pulled. Leave a slot blank to fall back to the General model.

---

## Build

```bash
# Windows unpacked directory + installer
npm run package:win

# Quick smoke check — no installer, faster
npm run package:dir
```

Artifacts land in `release/`. The executable is `release/win-unpacked/Helix.exe` and must stay alongside the rest of the `win-unpacked/` contents.

In packaged builds, `python_embeded/`, `inference_server/`, `comfyui_backend/`, and `skills/` are resolved from the Electron `resources/` directory. Logs and runtime data (`ollama-desktop.sqlite`, generation artifacts) live under Electron `userData`.

---

## Validation

```bash
npm run verify   # lint + typecheck + test + test:python + build
```

| Command | What it runs |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc` for main and renderer tsconfigs |
| `npm run test` | Vitest (Node + renderer) |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:python` | pytest via `python_embeded\python.exe` |
| `npm run build` | Production electron-vite build |

Run one file: `npx vitest run tests/node/my.test.ts`

---

## Architecture

Strict layer boundaries — never bypass them:

- `renderer/` communicates only through `window.ollamaDesktop` (contextBridge). No direct SQLite, Ollama, or Python access.
- `bridge/` owns all orchestration and is imported only from `electron/main`. Never from `renderer/`.
- The Python inference server is a localhost-only child process (`127.0.0.1:8765` by default). The renderer never calls it directly.

Data flow:

```
User → Zustand → window.ollamaDesktop (preload) → IPC
  → electron/main → ChatService → ChatRouter → OllamaClient
  → stream events → IPC → renderer

Image job:
  renderer → IPC → GenerationService → PythonServerManager
  → FastAPI (localhost) → polling → typed IPC updates → renderer
```

Context assembly order per turn:
1. System base prompt
2. Workspace prompt
3. Skill prompt
4. Pinned memory
5. Retrieved knowledge chunks
6. Summarized memory blobs
7. Recent raw turns
8. Current user turn

SQLite lives at `userData/data/ollama-desktop.sqlite`. All schema changes go through numbered migrations in `bridge/db/migrations/`. The schema is currently at migration 013.

See [docs/architecture.md](docs/architecture.md) for the full design record.

---

## Roadmap

| Milestone | Description | Status |
|---|---|---|
| 1 | Foundation — Electron shell, IPC, SQLite, Ollama connectivity | ✅ Done |
| 2 | Workspaces & chat UX — sidebar, search, attachments, model selector | ✅ Done |
| 3 | Routing & context — intent classifier, token usage, RAG assembly | ✅ Done |
| 4 | Tools & skills — built-in tools, skill loader, auto-routing | ✅ Done |
| 4.1 | Agentic tool surface — full capability set, permissions, audit log, native tool calling | ✅ Done |
| 5 | RAG & memory — chunking, embeddings, hybrid retrieval, citations, memory pruning | ✅ Done |
| 6.1 | Image generation — FastAPI worker, job persistence, inline rendering, cancellation | ✅ Done |
| 6.2 | VRAM management — headroom policy, backend eviction, status bar telemetry | ✅ Done |
| 6.3 | Queue hardening & notifications — queue replay, desktop notifications, retry flows | ✅ Done |
| 6.4 | Future generation surfaces — video jobs, gallery management | 🔲 Planned |
| 7 | MCP — server config, connection manager, tool manifest sync, resources, prompts | 🔲 Planned |
| 8 | Polish & release hardening — auto-update, crash recovery, accessibility, security pass | 🔲 Planned |

Full detail and per-item status: [docs/milestones.md](docs/milestones.md)

---

## Security

- The renderer has no direct access to the filesystem, SQLite, network services, or the Python worker. All calls go through the typed preload bridge.
- Agentic tool grants are persisted per-capability and audited in SQLite.
- The Python inference server binds to `127.0.0.1` only and is not reachable from outside the machine.
- Dangerous file extensions (`.exe`, `.bat`, `.ps1`, `.sh`, `.js`, etc.) are blocked in the `workspace-opener` tool.
- See [docs/security.md](docs/security.md) for the full threat model.

---

*Documentation generated by [Claude Sonnet 4.6](https://www.anthropic.com/claude) (claude-sonnet-4-6)*
