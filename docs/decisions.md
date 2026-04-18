# Decisions

## Electron-Vite for the bootstrap

The repository started almost empty, so `electron-vite` was chosen to get a strict Electron + Vite baseline running quickly while still preserving the requested folder boundaries.

## Zod-validated IPC contracts

IPC payloads and responses are defined centrally in `bridge/ipc/contracts.ts` and validated on both sides of the preload bridge. This keeps the renderer isolated from raw Electron primitives and hardens the IPC surface early.

## SQLite via Node built-in bindings

The foundation uses `node:sqlite` to avoid pulling native third-party SQLite bindings into the first milestone. This keeps the initial bootstrap lighter while still using real SQLite with WAL mode and migrations.

## Bundled Python is authoritative

`python_embeded` is treated as the self-contained application runtime. Electron main requires `python_embeded\python.exe` and validates its dependencies instead of falling back to system Python, which keeps behavior closer to the intended packaged product.

## Heavy-but-reinstallable Python packages are deferred to first launch

The packaged app still treats the embedded interpreter as authoritative, but a selected dependency slice now ships out-of-band from the Windows bundle and is restored on first launch into Electron `userData/python-runtime/site-packages`. This keeps the packaged runtime smaller while avoiding writes back into packaged app resources and preserving a deterministic pinned requirements file in `config/python-deferred-requirements.txt`.

## Python runtime stays bundled, but server code lives at the repo root

The embedded interpreter still lives under `python_embeded`, but the managed FastAPI package and bundled ComfyUI tree now live at the project root as `inference_server/` and `comfyui_backend/`. That keeps the repository layout aligned with the intended architecture while preserving the packaged-runtime boundary.

## Electron main build preserves modules

The production Electron main build now keeps Rollup `preserveModules` enabled. With the current tool, RAG, and bridge graph, forcing a single bundled main chunk caused an invalid emitted file during the final transpile step, while preserved modules produce a stable `dist/main/index.js` entrypoint plus internal chunks without changing the runtime boundary.

## Conversation and knowledge search stay inside SQLite

Both chat search and the first RAG slice use SQLite FTS5. This keeps retrieval local-first, restart-safe, and fully inside the main-process boundary without introducing a separate indexing service.

## Follow-up routing uses recent assistant metadata

The first routing slice does not use a heavyweight classifier. Instead, it carries forward tool and skill intent from the most recent assistant route trace when the user writes ambiguous follow-ups such as `continue`, `again`, or `use that tool again`. This improves continuity without adding a second model hop.

## Chat stays in Auto unless the user explicitly overrides it

The chat header now defaults to an `Auto` model mode instead of pinning every turn to the saved general model. This keeps normal conversation aligned with the configured General, Coding, and Vision roles from Settings while still allowing a one-off manual model override when the user chooses a concrete model in the header.

## Built-in tools expanded conservatively

Milestone 4 started with read-only deterministic tools first, then added code execution and web lookup only after there was a clearer safety boundary. The current tool set still prefers constrained, testable defaults over broad host access.

## Code runner is sandboxed JavaScript, not general host execution

The first code runner intentionally supports dependency-free JavaScript snippets only. It runs inside a worker-thread VM sandbox with blocked imports, no host APIs, timeout enforcement, memory ceilings, stdio capture, and temp-directory cleanup instead of exposing unrestricted Node, shell, or Python execution.

## Web search uses a read-only bridge-side fetch path

Web search is implemented as a bridge-owned, read-only fetch to a public search HTML endpoint with parsed source snippets, rather than a renderer-side browser integration or an API-key-backed service. This keeps the surface narrow and makes source provenance available to the transcript.

## Auto skill routing stays heuristic and local

The current tool and skill orchestration does not rely on a second model hop for function-calling. The bridge uses local heuristics to decide when to activate built-in skills such as builder, debugger, reviewer, grounded, and stepwise so common requests get better structure without adding latency or widening the IPC surface.

## Workspace folders are explicit, not implied

Workspaces can now bind to an optional local folder, but that binding is an explicit user action stored in SQLite rather than something inferred from imported documents or the current process directory. That keeps relative tool access predictable, local-first, and auditable.

## Calculator uses a parser, not eval

The calculator originally used dynamic execution, but that was replaced with a tiny arithmetic parser so the tool remains lint-clean, deterministic, and obviously safe.

## Browser-opened renderer should fail soft

The renderer dev server can be opened directly in a browser during development, but the desktop preload API only exists inside Electron. Instead of crashing, the renderer detects that context and shows a desktop-only notice so the failure mode is understandable.

## Markdown exports carry a hidden round-trip payload

Conversation exports stay readable as Markdown, but they also include a hidden encoded payload so imports can faithfully restore messages and attachment metadata without depending on brittle Markdown parsing alone.

## Metadata is rehydrated after terminal stream events

Assistant route traces, tool traces, usage, and sources are persisted in SQLite during bridge execution. The renderer rehydrates the conversation after terminal stream events so fast incremental updates and persisted metadata stay consistent without widening the streaming IPC event shape prematurely.

## Local embeddings are deterministic hash vectors

The first embedding layer uses deterministic local hash embeddings instead of a separate model-serving dependency. This keeps retrieval local-first and restart-safe while still allowing hybrid lexical-plus-semantic workspace search.

## Long chats prune into persisted summary memory

Long-running conversations now prune older completed turns into a persisted summary record keyed by conversation and cutoff message. Recent turns stay raw, pinned messages stay explicit, and the summary is regenerated deterministically whenever the summarized window changes.

## Image generation starts with a built-in placeholder backend plus user-selected local model roots

Milestone 6.1 begins with a built-in placeholder image backend and an additional-models-directory setting for local diffusers directories or checkpoint files. That keeps the generation pipeline testable on any machine, lets the queue/UI/IPC path be validated without mandatory downloads, and aligns better with existing local model stores such as ComfyUI `models` folders.

## Generation job state is durable in SQLite even though the Python queue is in-memory

The FastAPI worker currently owns the live queue in memory, but Electron main mirrors every observed job snapshot into normalized SQLite tables for `generation_jobs` and `generation_artifacts`. This keeps queue history restart-safe for the desktop app, while making the remaining gap explicit: full replay inside the Python worker still belongs to the next queue-hardening slice.

## VRAM state is surfaced through the existing health bridge

Instead of inventing a second telemetry channel for generation hardware state, the Python worker extends `/health` with loaded image-backend metadata and VRAM counters. Electron main folds that into the typed system-status payload, which keeps renderer observability aligned with the existing preload contract and makes runtime eviction and free-memory state visible through the same preload surface.

## GPU generation uses a single active execution slot with explicit runtime eviction

The Python worker now serializes image jobs through one active execution slot and treats diffusers pipelines plus the embedded ComfyUI sidecar as mutually exclusive GPU runtimes. That keeps multi-model generation predictable on consumer GPUs: a different diffusers model evicts the old pipeline first, switching to ComfyUI tears down diffusers state, switching back tears down the ComfyUI sidecar, and low-free-VRAM conditions fail early with a clear headroom error instead of overlapping into opaque OOM crashes.

## Image-generation preflight happens in the bridge before queue persistence

The Python worker still owns the authoritative runtime checks, but the bridge now performs a conservative preflight before it writes a new image job into SQLite or asks Python to start it. That lets the desktop app reject obviously unsupported discovered models, an offline Python worker, and GPU requests whose total VRAM budget can never satisfy the shared headroom estimate, which keeps "impossible" jobs out of both the persistent queue history and the live worker queue.

## Python queue replay lives beside the worker, not only in the SQLite mirror

SQLite remains the durable desktop-facing history of generation jobs, but the live replay responsibility now also lives inside the Python worker through a worker-owned queue state file. This keeps the boundary honest: Electron main still treats Python as the single orchestration point for execution, while unexpected worker restarts can resume queued/running jobs from Python's own state instead of forcing the bridge to immediately downgrade them to lost-state failures.

## Retrying a failed image job creates a fresh job record

The retry flow reuses the original request payload, but it always spawns a new generation job ID rather than mutating the failed or cancelled row in place. That preserves auditability and queue history, keeps terminal job state queryable in SQLite, and avoids having the renderer or bridge rewrite the meaning of an older failure record while still letting users recover quickly from transient GPU or worker failures.

## GGUF discovery is explicit about supported versus future families

ComfyUI-style model roots can contain very different GGUF families, and many of them are not interchangeable text-to-image checkpoints. The desktop catalog now surfaces GGUF entries with family metadata and support status instead of treating every `.gguf` file like a generic diffusers checkpoint. For the current Image Gen slice, Qwen Image text-to-image GGUF checkpoints are selectable, Qwen Image Edit 2511 GGUF checkpoints are selectable through the dedicated workflow-aware path, and Wan GGUF checkpoints remain visible but disabled until their matching video flows exist.

## Qwen Image Edit 2511 is modeled as a workflow profile, not a generic image preset

The Qwen edit flow is specific enough that it should not be flattened into the same request path as ordinary prompt-only image generation. The desktop generation schema now persists `mode`, `workflowProfile`, and normalized `referenceImages`, and the Python worker treats `qwen-image-edit-2511` as a distinct execution branch with workflow-specific defaults and reference-image handling through a vendored ComfyUI runtime inside the repo rather than depending on an external ComfyUI install.

## The broader agentic tool surface stays layered instead of collapsing into one generic dispatcher

Milestone 4.1 ships a large tool inventory, but it still keeps the architecture layered. `ToolDispatcher` remains the home for the original built-in local-workbench tools, while the broader capability surface lives behind `bridge/capabilities` with persistent records for permissions, tasks, schedules, agents, teams, worktrees, plan state, and audit events. That keeps the layer boundaries honest and leaves clear seams for future specialization into `bridge/files`, `bridge/commands`, `bridge/tasks`, `bridge/agents`, `bridge/worktrees`, `bridge/lsp`, `bridge/mcp`, and `bridge/scheduler` instead of pretending every capability should look like today's synchronous built-in tools.

## Mutating capability tools are offered through native tool-calling, not direct route analysis

Model-assisted route analysis now only sees tools marked `autoRoutable`, which excludes mutation-heavy or structured capability tools such as `write`, `edit`, shell execution, and task creation. Those tools still exist in the native Ollama tool loop with their typed schemas, but they are no longer pre-fired directly from a vague natural-language route decision. This keeps direct routing reliable for read-style tools while reserving state-changing actions for the more explicit tool-calling path.

## Connected workspaces should still provide context when search misses

`workspace-search` now treats "no matches" as a fallback context case rather than a dead end. When a connected workspace has no direct filename or text match, the tool returns a small top-level directory snapshot so the assistant can still see the available project roots instead of incorrectly concluding that no existing code is present.

## Desktop diagnostics are persisted under the app `logs` folder

The bridge logger now writes structured JSON logs to `logs/app.log` under the app root during development, while still emitting to stdout. Chat turns add explicit entries for incoming prompts, accepted routes, bridge tool executions, native tool calls, and final assistant completions so workspace and routing failures can be diagnosed after the fact without relying on the live console.

## Workspace-backed builder turns get a larger native tool budget

The native Ollama tool loop now gives connected `builder` and `debugger` turns a higher round budget plus an explicit batching prompt. Typical coding turns often need one inspection round, one or more read rounds, a couple of file mutations, a verification pass, and then a final assistant summary, so the generic round cap was too tight and could fail after successful edits but before the model returned its final response.

## Coding turns must verify the latest edits before they can finish

Workspace-backed `builder` and `debugger` turns now run in a bounded implement-verify loop. If the model edits files and then tries to stop without a later verification step, the bridge injects a follow-up system reminder and keeps the native tool loop running. That keeps the behavior focused on coding turns only, while pushing them toward an `implement -> check -> fix -> check` flow instead of a single mutation burst followed by an optimistic summary.

## Large coding scaffolds can extend the tool loop while progress continues

Coding turns still start with a smaller native tool round budget so obviously stuck loops fail quickly, but that initial budget is no longer a hard stop. When a workspace-backed coding turn keeps producing completed tool work, the bridge extends the implement-check loop in small bounded increments up to a hard cap, which lets larger scaffold jobs finish without giving unbounded freedom to spin forever.

## Native tool turns stream progress into the transcript before completion

The chat stream channel now carries incremental `update` events for assistant turns, not only token deltas and terminal completion. This lets the renderer show native tool activity and route metadata as the bridge executes local reads and edits, so coding turns feel alive in the transcript instead of appearing all at once after the final completion event.

## Ollama chat requests now pin the context window to 8192 tokens

The shared Ollama client now includes `options.num_ctx = 8192` on every `/api/chat` request. That keeps route analysis, standard chat, and native tool-calling turns aligned on a larger context window instead of depending on Ollama's model-specific default.

Transient `/api/chat` transport failures are also retried once before the turn fails, and the final error now preserves the underlying fetch cause when a retry still cannot recover. That makes long coding turns less brittle while giving logs enough detail to distinguish a network reset from a normal model/tool error.

## Local native tool loops stream their draft output instead of waiting for the full round

Workspace-backed native tool turns now keep the cloud path on the simpler `completeChat` request pattern, but local Ollama models stream each tool-planning round through `/api/chat` with `stream: true`. That lets the renderer receive live draft text during the assistant's local inspect/edit/check loop instead of waiting for the whole round to finish before anything appears in the transcript.

## Normal shell command exits are treated as command results, not tool failures

The local `bash` and `powershell` capabilities now reserve `failed` status for actual tool-level problems such as timeouts, spawn failures, or missing approvals. If the command starts and exits normally with a non-zero code, the invocation is still recorded as `completed` and the exit code stays in the returned content, which gives local models room to inspect stderr, adjust, and continue iterating instead of treating the shell tool itself as broken.

## Local coding loops get a much larger bounded round budget than cloud turns

Native tool loops now distinguish between cloud-hosted and local Ollama models. Local coding turns start with a higher round budget and can extend in larger increments up to a much higher hard cap, while cloud turns keep the tighter limits. This preserves runaway-loop protection but better matches the product goal of letting local models keep grinding through larger implement-check-fix cycles without hitting cloud-oriented usage ceilings.

## VRAM status is polled continuously and presented as usage, not just free memory

The desktop renderer now refreshes system status on a short interval after bootstrap so the status bar tracks changing GPU memory while local models load and unload. The VRAM pill also presents used-versus-total memory instead of free memory, which better matches the product's role as a live usage monitor for local-first inference.

## The edit tool accepts common alias fields and tolerates Windows line-ending differences

The local edit capability now accepts `oldText` and `newText` aliases in addition to `search` and `replace`, and its matching logic retries with normalized line endings before declaring a miss. That makes Windows workspace edits much more resilient when models copy `\n` line breaks from prior reads while the underlying files still use `\r\n`.

## Rich tool-progress metadata is best-effort, not turn-fatal

Local coding turns can accumulate large tool and context payloads while they inspect a workspace. Assistant progress and completion now try the full metadata payload first, then fall back to a smaller event or lighter persistence path if that richer payload is rejected, so a successful model run is not marked failed just because bookkeeping around tool traces or context sources hit an edge case.

## Packaged Windows builds resolve runtime assets from `resources`, not the repo root

The desktop app now treats Electron `process.resourcesPath` as the runtime root when packaged, which lets the installed `.exe` find the bundled `python_embeded`, `inference_server`, `comfyui_backend`, and `skills` directories without assuming a source checkout layout. Writable runtime files such as logs and monitor output moved to Electron `userData` so the installed app does not try to write inside the immutable install directory.

Because the bundled local-first runtime is several gigabytes once the embedded Python stack and inference backends are included, the current verified Windows packaging target is the unpacked app folder with `Helix.exe` inside `win-unpacked/`. NSIS-backed installer and portable single-file packaging both hit the same mmap limit on the generated payload archive at the current size, so the working deliverable for now is a double-clickable app executable that ships with its sibling resources directory intact.

## Tasks and plan state are workspace-scoped

Migration 013 adds `workspace_id` to `capability_tasks` and `plan_state`, making these subsystems respect workspace boundaries. Tasks created within a workspace are queryable only within that workspace (or globally if workspace_id is null), preventing task lists from bleeding across unrelated projects. The `plan_state` table now uses a composite primary key of `(workspace_id, conversation_id)` so that plan mode can be active per-workspace while still supporting null workspace_id for backward compatibility.
