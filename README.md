# Helix

[![Build](https://github.com/Konohamaru04/Abstergo-Helix/actions/workflows/build.yml/badge.svg)](https://github.com/Konohamaru04/Abstergo-Helix/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/Konohamaru04/Abstergo-Helix)](https://github.com/Konohamaru04/Abstergo-Helix/releases)

Helix is a local-first desktop AI workbench. Chat with local Ollama models or NVIDIA-hosted endpoints, run agentic tools against your workspace, retrieve from your own knowledge base, and generate images and video — all on your machine unless you explicitly opt into a cloud backend.

---

## Features

### Chat & Routing
- Multi-workspace, multi-conversation chat with SQLite persistence and FTS5 search
- Streaming replies with buffered rendering
- Intent classifier auto-routes turns: chat, skill-chat, tool, tool-chat, RAG-chat, RAG-tool
- Role-aware model slots: General, Coding, Vision
- Expandable thinking blocks parsed from `<think>...` sections
- Edit/resend, regenerate, retry, and stop in-flight replies
- Attachments with preview; import and export conversations

### Agentic Tools
The model can call tools through the bridge with audited permissions:

| Category | Tools |
|---|---|
| Filesystem | Read, Glob, Grep, Write, Edit |
| Shell | Bash, PowerShell, Monitor |
| Execution | code-runner (sandboxed JS), calculator |
| Search | web-search, knowledge-search |
| Tasking | TaskCreate, TaskUpdate, TodoWrite, CronCreate |
| Planning | EnterPlanMode, EnterWorktree |
| LSP | Language server protocol queries |
| Meta | Skill, Agent, SendMessage |

### Skills
Five built-in Markdown-driven skills auto-activate by intent: builder, debugger, reviewer, grounded, stepwise. You can also write custom skills in `skills/user/`.

### RAG & Memory
- Import documents into a workspace knowledge base
- Hybrid FTS5 + semantic retrieval with citations
- Conversation memory summarization and pruning; pinned messages survive

### Image & Video Generation
- **Text-to-image** — Local diffusers, `.safetensors`/`.ckpt`, Qwen Image GGUF
- **Image-to-image** — Qwen Image Edit 2511 via embedded ComfyUI workflow
- **Image-to-video** — Wan 2.2 GGUF via embedded ComfyUI
- Auto-detect generation intent in chat with confirmation before starting
- GPU headroom enforcement and backend eviction
- Desktop notifications on completion or failure

### Wireframe Mode
Guided app-design flow: the model asks multiple-choice questions and renders live sandboxed HTML/CSS/JS canvases. Export the final design as a standalone `.html` file.

---

## Installation

### End users

1. Download the latest release from the [Releases](https://github.com/Konohamaru04/Abstergo-Helix/releases) page.
2. Run `Helix-Setup-<version>.exe` (installer) or extract `Helix-Portable-<version>.exe`.
3. On first launch the splash screen provisions deferred Python packages automatically.
4. Open **Settings** and configure your text backend (Ollama or NVIDIA).

### Developers

Requires **Node.js 20+**.

```bash
git clone https://github.com/Konohamaru04/Abstergo-Helix.git
cd Abstergo-Helix
npm install
```

**Add the Python runtime:**

Download `Helix.v1.5.Windows.7z` from the [v1.5 release](https://github.com/Konohamaru04/Helix/releases/download/V1.5-Testarossa/Helix.v1.5.Windows.7z), extract `python_embeded/` into the repo root so that `python_embeded\python.exe` exists. This runtime is only required for image/video generation jobs; chat and tools work without it.

**Run in dev mode:**

```bash
npm run dev
```

The Vite dev server URL printed in the terminal is renderer-only; it does not expose the preload bridge in a browser.

**Configure the text backend:**

Open **Settings** in the app header.

| Backend | Setup |
|---|---|
| **Ollama** (default) | Ensure Ollama is running. Default URL: `http://127.0.0.1:11434` |
| **NVIDIA** | Switch `Text backend` to `NVIDIA`. Add your API key. Default URL: `https://integrate.api.nvidia.com/v1` |

Set **General**, **Coding**, and **Vision** model slots to the models you have pulled. Leave a slot blank to fall back to General.

---

## How to use

1. **Create a workspace** from the sidebar and optionally bind a local project folder.
2. **Start a conversation** and pick a model from the header selector. `Auto` routes to General / Coding / Vision based on the turn.
3. **Chat** normally, attach files, or use explicit directives:
   - `/tool <name>` to force a specific tool
   - `@skill <name>` to force a skill mode
4. **Import knowledge** into the workspace from the composer or sidebar, then ask grounded questions.
5. **Generate images** by switching the composer to Image mode, or let the chat auto-detect image prompts and confirm.
6. **Generate video** by attaching a start image and switching to Image to Video mode.
7. **Use Wireframe mode** for guided UI design — the model asks questions and renders interactive canvases you can export.

---

## npm scripts

```bash
npm run dev              # Start Electron in dev mode
npm run build            # Production build
npm run lint             # ESLint
npm run typecheck        # TypeScript check for main and renderer
npm run test             # Vitest (Node + renderer)
npm run test:watch       # Vitest watch mode
npm run test:python      # pytest via bundled python_embeded\python.exe
npm run verify           # lint + typecheck + test + test:python + build
npm run package:win      # Windows unpacked + installer
npm run package:dir_win  # Quick unpacked build (no installer)
```

Run a single test file: `npx vitest run tests/node/my.test.ts`

---

## Tech stack

| Layer | Tech |
|---|---|
| Shell | Electron 41 |
| Renderer | React 19, TypeScript 6, Tailwind CSS 3 |
| Build | electron-vite, Vite 7 |
| State | Zustand 5 |
| Persistence | SQLite (WAL, FK enforced) |
| Logging | Pino |
| Testing | Vitest, @testing-library/react, pytest |
| Text inference | Ollama (local), NVIDIA OpenAI-compatible API |
| Image/Video inference | FastAPI + diffusers + ComfyUI (managed child process) |
| Python runtime | Bundled `python_embeded\python.exe` |

---

## Roadmap

Milestones 1–6.4 and 8 are complete: foundation, workspaces, routing, tools, skills, RAG, image/video generation, VRAM management, queue hardening, and release polish.

Milestone 7 (MCP server integration) is planned.

Full tracker: [docs/milestones.md](docs/milestones.md)

---

## Security

- Renderer has no direct filesystem, SQLite, network, or Python access. All calls go through the typed preload bridge.
- Agentic tool grants are persisted per-capability and audited in SQLite.
- Python inference server binds to `127.0.0.1` only.
- Dangerous file extensions are blocked in the workspace opener.

Full threat model: [docs/security.md](docs/security.md)

---

## License

[GPL-3.0](LICENSE)
