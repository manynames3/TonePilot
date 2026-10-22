# TonePilot Lightroom plug-in — 0.1.0

TonePilot's own Lightroom Classic plug-in (SDK 8+). It replaces the third-party Lightroom MCP bridge for the TonePilot engine with the smallest surface the engine needs.

> **Not yet verified inside Lightroom.** The Lua has been syntax-checked with `luac` and run against stub SDK objects (`TonePilot/tests/plugin-harness.lua`); the engine has been tested against a mock of its protocol (`TonePilot/tests/mock-plugin.mjs`). Nothing here has run in Lightroom Classic. Until it has, the engine falls back to the MCP bridge whenever this plug-in is not running.

## What it does

- Listens on **localhost only**, ports 58781 (requests) and 58782 (responses). LrSocket sockets carry data one way, hence two ports. Messages are newline-delimited JSON: `{"id", "token", "action", "params"}` → `{"id", "result"}` or `{"id", "error"}`.
- On start it writes `~/Library/Application Support/TonePilot/bridge.json` (folder 0700, file 0600) with the ports and a random 256-bit token. Every request must carry that token; others get `Unauthorized`.
- Serves exactly eight actions: `hello`, `writable_keys`, `get_selected_photos`, `get_photo_metadata` (the MCP bridge's Develop field names plus `full`: every scalar Develop value), `get_photo_preview`, `set_develop_settings`, `create_snapshot`, `select_photos`.
- `set_develop_settings` accepts only WhiteBalance, Temperature, Tint, IncrementalTemperature, IncrementalTint, Exposure2012, Highlights2012, Shadows2012, Whites2012 and Blacks2012, within coarse slider ranges, as one History step named **TonePilot first pass** (restores: **TonePilot restore**; no other name is accepted).
- Starts with Lightroom (`LrForceInitPlugin`); no Plug-in Manager visit needed. **Library → Plug-in Extras → TonePilot Connection Status** shows its state.

## Install (manual, for testing)

1. Quit Lightroom Classic.
2. Copy `TonePilot.lrplugin` into `~/Library/Application Support/Adobe/Lightroom/Modules/`. Leave any existing `LightroomMCP.lrplugin` where it is; the two use different ports.
3. Start Lightroom. Check **File → Plug-in Manager** lists TonePilot as enabled and running without errors.
4. Confirm `~/Library/Application Support/TonePilot/bridge.json` exists with mode `-rw-------`.

To remove it, quit Lightroom and delete the folder (and `bridge.json`). The TonePilot app bundles a copy in `Contents/Resources/TonePilot.lrplugin` for a future installer; the build never installs it.

## Verifying inside Lightroom

Use a **backed-up sandbox catalog**, never a working one. Steps 1–4 are read-only.

1. `node TonePilot/Engine/engine.mjs --mode doctor --live` — `tonepilot-plugin` is listening and the live check says "TonePilot plug-in 0.1.0 answered".
2. `--mode inspect` with a few photos selected — `bridgeKind: "tonepilot"`, correct IDs and filenames. Select nothing and check Lightroom reports the whole filmstrip, as with the MCP bridge.
3. `--mode analyze` on RAW and HEIC photos (with `TONEPILOT_RUNS_DIR` pointing at a scratch folder) — previews arrive; the journal's `snapshot.full` holds Lightroom's Develop keys; HEIC photos get relative white balance.
4. Run `inspect` twice without touching Lightroom and compare two `get_photo_metadata` results for one photo: no value in `full` may change by itself (a volatile key would make every photo look edited).
5. `--mode select --ids '[…]'` — Lightroom selects those photos; Develop History is unchanged.
6. Apply and restore on the sandbox catalog only, with the owner's approval (`tests/live/sandbox-cycle.mjs` protocol). Check: History shows a **TonePilot first pass** step per write and **TonePilot restore** per restore; the Snapshots panel shows **TonePilot before …** once per photo; every write reads back `verified` (if a `full` key moves as a side effect of a write, it will show as `apply-mismatch` — record which); restore returns the original values.
7. Quit and relaunch Lightroom, and use **File → Plug-in Manager → Reload Plug-in**: the engine must reconnect each time without a Plug-in Manager visit.

Record the results in `docs/EVIDENCE.md` before relying on the plug-in.

## Open questions about the SDK

- `LrPhoto:createDevelopSnapshot(name, update)` — the plug-in calls it inside `withWriteAccessDo` and reports `{supported: false}` when the method does not exist. The exact SDK version that added it, and whether it creates a History step of its own, are unverified.
- The step name is passed to `applyDevelopSettings(settings, historyName)` (and as the `withWriteAccessDo` undo name); that this Lightroom version shows it in History is unverified.
- `withWriteAccessDo` is called with `{timeout = 10}`; how this Lightroom version reports a timeout is unverified (the plug-in errors if the write function did not run).
- That LrSocket accepts only local connections is from the SDK's documented behaviour, not measured here.

## Known limitation

The token guards **requests** only. The response port is a fixed localhost port, so another process on this Mac that connects to it before the engine could read responses (photo metadata and previews), though it cannot make Lightroom do anything. The third-party MCP bridge has the same exposure. Fixing it needs responses tied to the token (for example, encrypted with it).

Mixed bridges: a session analyzed through this plug-in and applied after a fallback to the stock MCP bridge compares only the fields both report. A hand change to a JPEG/HEIC photo's relative white balance in between is then not seen as an edit; TonePilot's write in that case can only be exposure or tone (the MCP bridge cannot write relative white balance), so no edit is overwritten.
