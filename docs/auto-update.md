# Auto-Update

Helix checks for updates in the background and surfaces available updates through the status bar.

## Architecture

- **Update polling**: `bridge/update/service.ts` — polls GitHub Releases API on a configurable interval (default 30 minutes).
- **Status bar pill**: `renderer/components/status-bar.tsx` — shows an update-available indicator when a new version is detected.
- **Manual check**: `IpcChannels.updateCheckNow` — triggers an immediate check from the settings drawer or status bar.

## Flow

1. On app boot, `UpdateService` starts polling in the background.
2. When a newer version is found, the service stores the result and emits a status event.
3. The renderer status bar renders a "Update available" pill with the version number and release URL.
4. Clicking the pill opens the release page in the system browser (no in-app update installation).

## Design Decisions

- **No in-app binary replacement**: Updates require downloading and installing the new release manually. This avoids the complexity and security concerns of in-place binary patching.
- **GitHub Releases as source**: The release API is the single source of truth. No custom update server.
- **Non-intrusive notification**: The pill is informational only — it does not block or interrupt the user.

## IPC Channels

| Channel | Direction | Schema |
|---------|-----------|--------|
| `update:check-now` | Renderer → Main | No payload |
| `update:get-latest` | Renderer → Main | Returns `UpdateCheckResult \| null` |
| `update:status-event` | Main → Renderer | `UpdateCheckResult` event |