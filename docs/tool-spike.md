# Tool Spike

Updated: 2026-04-16

## Outcome

Milestone 4.1 is now implemented in the app.

This document remains useful as the original design record because it provided:

- a tool-by-tool architecture decision for the requested surface
- a permission model split into no-approval, confirm-once, and always-confirm classes
- a concrete implementation sequence that fits the current Electron main / typed IPC boundary
- acceptance criteria for renderer UX, IPC, audit logging, and tests

The implementation now exists in `bridge/capabilities`, the typed preload IPC surface, the settings drawer capability controls, and the native Ollama tool registry. The sections below are kept as the design rationale that shaped that implementation.

## Core decisions

These decisions close the spike:

1. The current `ToolDispatcher` remains the safe local-workbench layer, but it is not the final home for every requested capability.
2. Risky or long-lived capabilities must not be bolted onto the existing read-only tool path. They need dedicated orchestration services under `bridge/`.
3. Shell, write, scheduling, tasks, agents, worktrees, notebooks, LSP, and MCP resources need normalized persistence and audit events before they are exposed in the renderer.
4. The renderer continues to talk only through typed preload IPC. No new capability may bypass Electron main.
5. The product default remains automatic model-assisted routing. Manual directive syntax can stay as an advanced override, but manual picker-heavy UX is not the product direction.

## Capability map

| Capability | Decision | Owning layer | Why |
| --- | --- | --- | --- |
| `Agent` | First-class subsystem | `bridge/agents/*` | Needs lifecycle, transcript state, context isolation, and child-task visibility. |
| `AskUserQuestion` | First-class subsystem | `bridge/questions/*` | It is an interaction primitive, not a generic tool invocation. |
| `Bash` | First-class risky tool | `bridge/commands/*` | Needs approvals, audit logs, workspace scoping, timeouts, and output capture. |
| `CronCreate` | First-class scheduler API | `bridge/scheduler/*` | Session scheduling is durable orchestration, not a normal tool call. |
| `CronDelete` | First-class scheduler API | `bridge/scheduler/*` | Same as above. |
| `CronList` | First-class scheduler API | `bridge/scheduler/*` | Same as above. |
| `Edit` | First-class risky tool | `bridge/files/*` | Needs diff-aware edits, approvals, and auditability. |
| `EnterPlanMode` | Interaction/runtime mode | `bridge/plans/*` | This changes conversation behavior rather than invoking a host tool. |
| `EnterWorktree` | First-class git/workspace API | `bridge/worktrees/*` | Needs isolated worktree lifecycle and path switching. |
| `ExitPlanMode` | Interaction/runtime mode | `bridge/plans/*` | Depends on plan-state persistence and approval flow. |
| `ExitWorktree` | First-class git/workspace API | `bridge/worktrees/*` | Depends on worktree lifecycle support. |
| `Glob` | Safe read tool | `bridge/tools/*` or `bridge/files/*` | Fits the local read/search family once generalized beyond current workspace listing. |
| `Grep` | Safe read tool | `bridge/tools/*` or `bridge/files/*` | Fits the local read/search family once generalized beyond current workspace search. |
| `ListMcpResourcesTool` | First-class MCP API | `bridge/mcp/*` | Resource listing belongs with the MCP connection manager. |
| `LSP` | First-class code intelligence API | `bridge/lsp/*` | Needs workspace indexing, diagnostics, and language-server lifecycle. |
| `Monitor` | First-class risky command runner | `bridge/commands/*` | Long-lived background execution does not fit the current synchronous tool path. |
| `NotebookEdit` | First-class notebook API | `bridge/notebooks/*` | Needs cell-aware semantics, not raw JSON write support. |
| `PowerShell` | First-class risky tool | `bridge/commands/*` | Same control surface as Bash, but Windows-specific. |
| `Read` | Safe read tool | `bridge/files/*` | Generalizes current `file-reader`. |
| `ReadMcpResourceTool` | First-class MCP API | `bridge/mcp/*` | Resource reads belong with MCP connection state and caching. |
| `SendMessage` | First-class agent API | `bridge/agents/*` | Depends on agent lifecycle and routing. |
| `Skill` | First-class skill activation API | `bridge/skills/*` | Skills exist already, but explicit execution should not be smuggled through chat directives only. |
| `TaskCreate` | First-class task system | `bridge/tasks/*` | Needs durable state and dependency model. |
| `TaskGet` | First-class task system | `bridge/tasks/*` | Same as above. |
| `TaskList` | First-class task system | `bridge/tasks/*` | Same as above. |
| `TaskOutput` | First-class task system | `bridge/tasks/*` | Same as above, though likely backed by file reads. |
| `TaskStop` | First-class task system | `bridge/tasks/*` | Same as above plus cancellation. |
| `TaskUpdate` | First-class task system | `bridge/tasks/*` | Same as above. |
| `TeamCreate` | First-class multi-agent API | `bridge/agents/*` | Depends on agent-team lifecycle and ownership. |
| `TeamDelete` | First-class multi-agent API | `bridge/agents/*` | Same as above. |
| `TodoWrite` | Fold into task system | `bridge/tasks/*` | Product should avoid parallel checklist models. |
| `ToolSearch` | First-class discovery API | `bridge/discovery/*` | Needs built-in plus MCP capability indexing. |
| `WebFetch` | Risk-managed network tool | `bridge/web/*` | Separate from search because fetch returns raw remote content. |
| `WebSearch` | Safe network tool | `bridge/web/*` | Current implementation can graduate into the generalized web tool surface. |
| `Write` | First-class risky tool | `bridge/files/*` | Needs approval and path guardrails before exposure. |

## Permission model

The future tool surface will use three permission classes plus one blocked class:

| Class | Meaning | Examples |
| --- | --- | --- |
| `No approval` | Safe read-only or interaction-only actions that stay within explicit local boundaries or conversation state. | `Agent`, `AskUserQuestion`, `EnterPlanMode`, `Glob`, `Grep`, `Read`, `TaskGet`, `TaskList`, `ToolSearch`, `ListMcpResourcesTool`, `ReadMcpResourceTool` |
| `Confirm once` | Potentially expensive, stateful, or long-lived actions that are not inherently destructive but should require an explicit grant for the current workspace/session. | `CronCreate`, `CronDelete`, `CronList`, `EnterWorktree`, `ExitWorktree`, `LSP`, `SendMessage`, `Skill`, `TaskCreate`, `TaskUpdate`, `TaskStop`, `TeamCreate`, `TeamDelete`, `TodoWrite`, `WebSearch` |
| `Always confirm` | Actions that can write, execute commands, spawn background runtime load, or access arbitrary remote content. | `Bash`, `Edit`, `ExitPlanMode`, `Monitor`, `NotebookEdit`, `PowerShell`, `WebFetch`, `Write` |
| `Blocked by policy until implemented` | Capabilities that should not surface to models or users until their owning subsystem exists with audits and tests. | any capability listed above whose owning subsystem is still missing |

Rules:

- approvals are granted and enforced in Electron main, never in the renderer
- grants are scoped to workspace plus session when possible
- every confirm-once or always-confirm action creates an audit event
- denials are also audited
- blocked capabilities must not be advertised as available in discovery responses

## Data model requirements

The spike defines these required persistent records before the new tool surface ships:

- `permission_grants`
  - capability id
  - scope type and scope id
  - grant level
  - granted at / expires at
  - granted by user action correlation id
- `audit_events`
  - capability id
  - action type
  - outcome
  - correlation id
  - sanitized input summary
  - sanitized output summary or error
- `tasks`
  - title
  - status
  - details
  - workspace_id (nullable, scoped to workspace)
  - owner type
  - dependency graph metadata
- `scheduled_prompts`
  - schedule kind
  - recurrence metadata
  - prompt payload
  - enabled / disabled state
- `agent_sessions`
  - agent kind
  - parent conversation or parent task
  - status
  - context handoff summary
- `worktree_sessions`
  - repo root
  - worktree path
  - branch
  - active / closed state
- `plan_state`
  - conversation_id (nullable)
  - workspace_id (nullable, part of composite primary key)
  - status (inactive/active)
  - summary
  - primary key: (workspace_id, conversation_id)

## Renderer requirements

The spike establishes these UX rules:

- approvals appear inline in the chat/task flow, not as hidden background failures
- tasks, schedules, and agents get first-class surfaces rather than being buried in tool trace text
- the queue drawer remains generation-focused unless task execution is intentionally merged into a broader operations drawer
- the composer stays automation-first: models choose tools automatically, while advanced overrides remain secondary
- risky actions must show human-readable scope before confirmation
- disconnected or blocked capabilities must render explicit availability state

## IPC requirements

Every future capability in this spike must:

- define a zod-validated request/response contract
- stream progress through typed event channels when long-running
- use correlation ids that connect user action -> approval -> execution -> audit event
- return capability availability state separately from invocation results
- avoid leaking raw shell/process handles to the renderer

## Audit requirements

Every confirm-once or always-confirm action must write audit events for:

- approval requested
- approval granted or denied
- execution started
- execution completed, failed, cancelled, or timed out

Audit payloads must exclude:

- secrets
- raw document contents
- full command output unless explicitly marked safe and bounded

## Test requirements

The spike defines these mandatory test groups for implementation slices:

- IPC contract validation for every new capability
- approval enforcement and denial coverage
- audit-event persistence coverage
- filesystem boundary and path traversal coverage
- shell timeout, cancellation, and output truncation coverage
- task dependency and status transition coverage
- scheduler creation/list/delete coverage
- agent lifecycle and message routing coverage
- MCP resource list/read coverage
- renderer interaction coverage for approval prompts and capability availability states

## Delivery slices

Implementation should follow this order:

1. shared execution foundation
   - permissions
   - approval UX
   - audit events
   - generalized capability registry
2. read and network parity
   - `Read`
   - `Glob`
   - `Grep`
   - `WebFetch`
   - generalized `WebSearch`
3. write and command execution
   - `Write`
   - `Edit`
   - `Bash`
   - `PowerShell`
   - `Monitor`
4. planning and tasks
   - `EnterPlanMode`
   - `ExitPlanMode`
   - `Task*`
   - `TodoWrite`
5. agent orchestration
   - `Agent`
   - `SendMessage`
   - `TeamCreate`
   - `TeamDelete`
6. repo and document specialization
   - `EnterWorktree`
   - `ExitWorktree`
   - `NotebookEdit`
   - `LSP`
7. MCP and discovery
   - `ListMcpResourcesTool`
   - `ReadMcpResourceTool`
   - `ToolSearch`
8. scheduling
   - `CronCreate`
   - `CronDelete`
   - `CronList`

## Acceptance checklist

Milestone 4.1 is now complete in implementation terms because:

- the requested capability surface is implemented behind typed IPC and bridge-owned orchestration
- permission grants, stateful records, and audit events are persisted in SQLite
- the renderer exposes capability state and permission controls
- models can access the implemented capability set through Ollama-native tool calling
- node and renderer tests cover permission enforcement, capability discovery, and native capability tool execution
- the milestone tracker now reflects 4.1 as shipped tool parity rather than a design-only spike
