# TonePilot contributor and agent instructions — v0.6

TonePilot is a **Lightroom Classic companion**. It is not a RAW editor, catalog manager, photo viewer or exporter. Lightroom is where photos are viewed and finished.

## Safety contract (do not weaken)

- No general-purpose model gets Lightroom tools. The model returns a schema-constrained assessment; `TonePilot/Engine/engine.mjs` is the only writer, through `guard.mjs`.
- `analyze` is read-only. `apply` and `restore` need `--confirm` and act only on IDs in the session journal.
- Journal first: `write-intent` / `restore-intent` (and `snapshot-intent` before the one non-Develop catalog write, a named Lightroom snapshot through TonePilot's plug-in) must be fsync'd before the Lightroom call; results come only from read-back values.
- Session status is derived from photo states (`session.mjs`). Never store or emit a status the photo states don't support.
- Never overwrite a photographer's edit: stale photos are skipped; restore only touches TonePilot's own keys while they still hold TonePilot's values.
- Writable keys: Temperature, Tint (RAW), IncrementalTemperature, IncrementalTint (JPEG/HEIC/TIFF, only when the bridge accepts them), Exposure2012, Highlights2012, Shadows2012, Whites2012, Blacks2012. WhiteBalance only to restore an original mode. Nothing else.
- Limits are cumulative from each photo's origin (`lineage.mjs`). Model output is never permission to exceed them.
- The Lightroom MCP bridge is pinned (`BridgeServer/package-lock.json`, `TESTED_BRIDGE_VERSION`). Upgrading it means re-running gate G1.
- TonePilot's own plug-in (`TonePilot/LightroomPlugin`) keeps its write allowlist identical to `guard.mjs` ALLOW + WhiteBalance (a test enforces it). It is unverified inside Lightroom: never install it into the owner's Lightroom without their approval, and run its first writes only under the G1 sandbox protocol.
- Never use a sandbox-bypass flag. Never run real writes outside `tests/live/sandbox-cycle.mjs` on a backed-up sandbox catalog with the owner's explicit approval.
- `MAX_JOB_PHOTOS` stays 20 until gate G4 passes.

## Truthfulness

- Keep [docs/EVIDENCE.md](docs/EVIDENCE.md) the source of every claim, with real / simulated / not-measured kept apart.
- As of 0.6.0: real read-only analysis on 5 HEIC photos and single RAW photos; 16 real writes made by the owner (13 RAW, 3 HEIC), all verified, 7 of them white balance on RAW (restore not yet exercised on real photos); no RAW gallery; no quality benchmark; no time-savings evidence; model confidence uncalibrated.
- White balance on JPEG/HEIC needs a bridge that accepts `IncrementalTemperature`/`IncrementalTint`; stock bridge 0.24.1 does not. Never modify the third-party bridge or plug-in without the owner's explicit approval.
- Public screenshots use synthetic demo sessions (`tests/demo-sessions.mjs`), never client photos, filenames or AI descriptions of them.

## Workflow

1. `node --test TonePilot/tests/*.test.mjs` before every commit. Add a failing test before fixing a safety bug.
2. `./TonePilot/build.sh` (use `TONEPILOT_APP_PATH` to build somewhere other than `~/Applications`).
3. Real read-only checks: `engine.mjs --mode doctor --live`, `--mode inspect`, `--mode analyze` with `TONEPILOT_RUNS_DIR` pointing at a scratch folder.
4. Never commit catalogs, originals, previews, session folders, logs, tokens or credentials.

Out of scope: login/accounts/billing, culling, retouching, a second photo browser, mobile.
