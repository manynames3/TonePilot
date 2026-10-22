# TonePilot v0.4 audit and v0.5 disposition

Audit of commit `c92a2b2` (v0.4.0), October 21–22, 2026. Findings are ranked by the harm a paying photographer could suffer, then by how often they would hit it. Line references are to `c92a2b2`. "Fixed" means fixed **and covered by an automated test** unless stated otherwise; most tests run against the simulated Lightroom bridge (see [EVIDENCE.md](EVIDENCE.md) for what is real).

## Critical — recovery and write safety

| # | Finding (v0.4) | Customer impact | v0.5 |
|---|---|---|---|
| A1 | `doRestore` skipped photos in `restore-started` and then set the session to `restored` (`engine.mjs:216,229`). An interrupted restore was later reported as complete. | Photographer told originals are back when a photo still carries AI edits. | **Fixed.** Status is derived from per-photo states on every read; `restoring` is unresolved until reconciled from real values. Test: *interrupted restore is never reported as restored* (mutation-checked). |
| A2 | The restore pointer lived only in memory (`WorkspaceModel.swift:42`), was cleared when a new analysis started (`:185`), lost on relaunch, and never set for partial sessions (`:309`). | After a crash or relaunch, no way to undo from the app. | **Fixed.** Every session is rebuilt from its journal; the sidebar lists all sessions with derived status; launch opens any interrupted session. |
| A3 | A photo stuck in `write-started`/`write-returned` made restore throw for the whole session (`engine.mjs:217`), and nothing ever settled it. | One ambiguous write blocks undo of every other photo. | **Fixed.** `reconcile` classifies each unconfirmed write from read-back values (applied / not applied / differs); a write is not declared "not applied" until a settle window passes. |
| A4 | Pre-write checks covered only the keys being changed; post-write compared all keys to the *analysis-time* snapshot (`:183,192`). An unrelated slider moved by the photographer let TonePilot write, then fail into an unrestorable `write-returned` state. | Writes into photos the photographer was actively editing; then strands them. | **Fixed.** Any change to the photo's exposed Develop state since analysis makes it *stale* (skipped, explained); post-write checks compare against the state read immediately before the write. Test: *an unrelated manual edit … makes only that photo stale* (mutation-checked). |
| A5 | Limits were measured from each session's baseline (`guard.mjs:48`), so repeated runs compounded. | Five runs at "+0.75 EV max" could move a photo +3.75 EV. | **Fixed.** Session lineage carries each photo's pre-TonePilot origin; caps are cumulative. A manual edit makes the photographer's value the new origin. |
| A6 | No concurrency control. macOS does not kill an orphaned engine when the app is force-quit; a relaunched app could start a second writer beside it. | Two processes writing the same photos. | **Fixed.** Engine-wide lock (PID + process-name check); the engine watches its parent and stops after the current photo if the app goes away. |
| A7 | Restoring Temperature/Tint left White Balance as `Custom` instead of the original mode. | "Restored" photo is not actually the original. | **Fixed.** Restore re-selects the original WB mode and verifies Temperature, Tint and mode. |
| A8 | The Lightroom bridge was launched with an unpinned `npx -y @mskalski/lightroom-mcp`, so whatever npm served that day received catalog write access. | Supply-chain risk on every run; needs network. | **Fixed.** Bridge 0.24.1 bundled from a committed lockfile (96 integrity hashes, install scripts disabled); fallback is pinned to the exact version; untested bridge versions raise a warning. |
| A9 | The AI subprocess ran with its working directory set to the folder holding every session journal (`engine.mjs:94`). | A model with read access next to client filenames and settings. | **Fixed.** Each assessment runs in an empty private temp folder with a read-only sandbox and schema-constrained output. |
| A10 | The whole session JSON was rewritten (no fsync) on every state change. | Not crash-durable; O(n²) bytes at gallery scale. | **Fixed.** Append-only journal, fsync per record, torn-tail tolerant, corruption detected and write-blocking. |
| A11 | Lightroom reports the entire filmstrip when nothing is selected; the bridge cannot tell the difference. | A forgotten selection authorizes unintended photos. | **Mitigated, open.** The app shows every filename being authorized and warns about this behaviour; the pilot limit (20) bounds the blast radius. |

## High — Lightroom integration and correctness

| # | Finding | v0.5 |
|---|---|---|
| B1 | The only real-photo run (Oct 21) used an engine older than the one shipped: its record has no `sourcePath`/`snapshot`, and the app was rebuilt 11 minutes later. The shipped analyze path had never touched real Lightroom. | **Verified now**, read-only: two complete real analyses of the same five photos (see EVIDENCE.md). |
| B2 | For JPEG/HEIC/TIFF Lightroom stores *Incremental* Temperature/Tint, which the bridge's write allowlist does not include. v0.4 skipped white balance silently. | Explicit per-file capability; the plan says why WB is unavailable. |
| B3 | Video files and legacy process versions were not handled. | Reported as unsupported with a reason. |
| B4 | Restore required the live Lightroom selection to match the session exactly — impractical after a relaunch. | Restore is authorized by the journal and checked per photo by catalog identity and exact post-edit values. |
| B5 | The bridge server times out after 30 s while the plug-in may still apply the write. | Timeouts poll read-back; an unconfirmed write stops the run and stays unresolved until settled. |
| B6 | Proposals were not rounded to slider granularity, inviting read-back mismatches. | Rounded (0.01 EV, whole units elsewhere); mismatches are reported, never called verified. |
| B7 | The review "report" was a Markdown table rendered by SwiftUI `Text`, which does not render tables. | Native review screen; plain-text report kept for export. |
| B8 | Dead code: an unused direct-Codex editing path with `--approve-for-me`, a duplicate selection scanner, a luminance-only metrics tool. | Removed. |
| B9 | Hard-coded paths, including the developer's `~/Documents/Lightroom-AI-FirstPass` baked into the app. | Removed; Lightroom found by bundle ID; developer overrides only via environment variables. |

## Photographic engine

| # | Finding | v0.5 |
|---|---|---|
| C1 | Each photo judged in isolation by an LLM returning absolute slider values; no scene concept; "looks" were prompt wording. | Scene grouping (time, body, flash, metered light, as-shot WB, surroundings); scene-median aggregation of model judgments; looks and strengths are enforced numbers. |
| C2 | One white-balance cap (±800 K) whatever the light; 800 K is enormous under tungsten. | Caps in mired (perceptually uniform). |
| C3 | Global histogram only. | On-device face detection and skin-region measurement; highlight-headroom curve limits brightening. |
| C4 | Model confidence used as a hard gate as if calibrated. | Thresholds differ by strength and are labelled uncalibrated in the UI; calibration tooling added for real ratings. |
| C5 | Model run-to-run noise unmeasured. | **Measured, open:** 4/5 decisions and 3/5 exact settings agreed across two identical real runs; the categorical judgment agreed 5/5. |

## UX and onboarding

| # | Finding | v0.5 |
|---|---|---|
| D1 | About a third of the window was decorative (illustrated "looks", botanical rail, slogans). | Removed; dense native layout; light and dark. |
| D2 | All-or-nothing apply. | Per-photo approval (checkbox, Space), approve all/none. |
| D3 | No way to see original → proposed → read-back → restored values. | Shown per setting with verification state. |
| D4 | Setup errors surfaced as one generic alert. | Setup checklist (12 checks incl. a live bridge handshake), each with a concrete fix. |
| E1 | Node.js, Codex CLI and the Lightroom plug-in must still be installed by hand. | **Open.** The bridge server is bundled; Node and Codex are not. |
| E2 | Not signed with Developer ID or notarized. | **Open.** Build and notarization scripts are ready; no credentials were used. |

## Commercial blockers that remain

1. **No evidence of photographic quality or time saved.** Gates G1–G3 in [VALIDATION.md](VALIDATION.md).
2. **Throughput and cost.** ~8 s and ~20,000 input tokens per photo through the Codex CLI agent harness. A 500-photo gallery would take roughly 35–40 minutes of AI time at the current concurrency.
3. **Differentiation.** Competitors learn a photographer's style from thousands of edits at flat prices. See [COMPETITIVE.md](COMPETITIVE.md) for the recommended repositioning.
