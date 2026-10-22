# TonePilot for macOS — source

| Path | Contents |
|---|---|
| `Source/` | SwiftUI app: `TonePilotApp` (shell, sidebar, progress), `StartViews` (setup, new pass), `SessionViews` (review, apply, recovery), `AppModel`, `Engine` (process runner, paths), `Models`, `Components`, `Snapshot` (developer screenshots) |
| `Engine/` | Guarded Node.js engine and the Swift analyzer — see [Engine/README.md](Engine/README.md) |
| `BridgeServer/` | Pinned lockfile for the bundled third-party Lightroom bridge |
| `tests/` | Automated suites (mock Lightroom, mock AI, fault injection), `demo-sessions.mjs`, and `live/sandbox-cycle.mjs` (real writes, sandbox only) |
| `Benchmarks/` | Evaluation, repeatability and scale tools |

## Build

```bash
./TonePilot/build.sh
```

Builds into `~/Applications/TonePilot.app` (override with `TONEPILOT_APP_PATH`). Requires the Xcode Command Line Tools, Node.js 18+ and network access for `npm ci` of the pinned bridge and the Node.js download. The build compiles the app and analyzer, runs the analyzer self-test, bundles the engine, the bridge and the Node.js runtime, signs (ad-hoc by default, Developer ID with `TONEPILOT_SIGN_IDENTITY`), verifies the signature, and only then replaces the installed app. It is not notarized unless you run `notarize.sh`.

The bundled runtime is the official Node.js darwin-arm64 build pinned in `build.sh` by version and SHA-256 (from nodejs.org's `SHASUMS256.txt`), cached in `TonePilot/.build/`. Only `bin/node` ships, as `Contents/Helpers/node`; it alone gets the JIT entitlement (`Node.entitlements`) under the hardened runtime. The app runs the engine, the bridge and the Codex CLI on it. `TONEPILOT_BUNDLE_NODE=0` skips it, and the app then falls back to a system Node.

The app uses `@StateObject` instead of `@State` deliberately: on the macOS 27 SDK, `@State` is a macro whose plugin ships only with full Xcode.

## Test

```bash
node --test TonePilot/tests/*.test.mjs
```

Never touches a real catalog. CI (`.github/workflows/ci.yml`) runs this suite and a temp-folder build (no bridge download, no install) on every pull request and push to `main`. For UI review without real photos: `node TonePilot/tests/demo-sessions.mjs /tmp/demo-runs`, then launch the app with `TONEPILOT_RUNS_DIR=/tmp/demo-runs`. Add `TONEPILOT_SNAPSHOT_DIR=/tmp/shots` to have the app render each screen to PNG and quit.

## Data

Sessions live in `~/Library/Application Support/TonePilot/runs/session-*/` (owner-only): `journal.jsonl` is authoritative; `session.json` and `report.txt` are rebuilt views. They contain filenames and Develop values — treat them as client data. TonePilot 0.4 sessions are listed read-only.
