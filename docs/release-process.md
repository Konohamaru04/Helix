# Release Process

## Version Bumping

```bash
node scripts/bump-version.mjs <major|minor|patch>
```

Updates `package.json` and `package-lock.json`, commits with `release: vX.Y.Z`, and tags.

Flags:
- `--no-tag` — skip git tag
- `--no-commit` — skip git commit

## CI

### Build Workflow (`.github/workflows/build.yml`)

- Triggered on push/PR to `master` or `main`.
- Runs on `windows-latest`.
- Steps: `npm install` → `npm run build`.

### Release Workflow (`.github/workflows/release.yml`)

- Triggered on push to `master` or manual dispatch.
- Runs on a self-hosted Windows runner.
- Links the staged `python_embeded` runtime.
- Runs `scripts/release-windows.ps1` which:
  1. Installs dependencies
  2. Builds the Electron app
  3. Packages into an unpacked directory
  4. Compresses into `Helix.v1.0.Windows.7z`
  5. Uploads to GitHub release `V1.0-Diablo`

## Packaging

### electron-builder.yml

- App ID: `com.abstergo.helix`, product name: `Helix`
- Targets: `dir` (unpacked), `nsis` (x64 installer), `portable` (x64)
- `afterPack` hook: `scripts/electron-builder-after-pack.mjs` — verifies required resources and scans for leaked `.pdb` files.

### Known Constraints

- NSIS and portable targets may fail at current payload size due to memory-mapped file limits on Windows (see `docs/decisions.md`).
- The verified deliverable is the unpacked directory from the `dir` target.
- `python_embeded` is bundled as an `extraResource` with deferred package exclusions to keep the package size manageable.

## Security Checklist

Before a release:

1. Run `node scripts/audit-ipc-handlers.mjs` — verifies all payload-accepting IPC handlers call `*Schema.parse()`.
2. Verify CSP headers in `electron/main.ts` — production CSP should have `default-src 'self'`, `object-src 'none'`.
3. Check `webPreferences` — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (deferred, see accessibility docs).
4. Verify `ALLOWED_EXTERNAL_PROTOCOLS` in `electron/main.ts` — only `https:`, `http:`, `mailto:`.
5. Run `npm run verify` — lint, typecheck, tests, Python tests, and build.