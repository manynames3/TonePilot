# Evidence — what has actually been measured

Every claim TonePilot makes should trace to a row here. Three kinds of evidence are kept apart:

- **Real, read-only** — the real Lightroom Classic catalog and real photos; nothing written.
- **Simulated** — the real engine against a mock Lightroom bridge and mock AI.
- **Not yet measured** — stated so nobody mistakes the absence of a failure for proof.

Machine: Apple M4 Mac mini, 16 GB, macOS 27, Lightroom Classic 14.5.1, Lightroom MCP plug-in and bridge 0.24.1, Codex CLI 0.160.0, Node 22.23.1.

## Real Lightroom, read-only (October 21, 2026)

The user's existing selection of five iPhone HEIC photos from one outdoor family shoot (the same photos analysed by v0.4 on the same day). No Develop setting was written; sessions were stored in a scratch folder, not the user's Application Support.

| Check | Result |
|---|---|
| Setup doctor with live bridge handshake | 12/12 checks passed, 4.0 s |
| Selection read (`inspect`) | 5 photos, correct IDs and filenames, 1.7 s |
| File capability detection | HEIC exposes 23 Develop fields and no numeric Temperature/Tint → white balance correctly reported as unavailable |
| Lightroom preview fetch | 44–207 ms per photo; one preview came back at 416 × 312 although ≥ 640 px was requested |
| On-device analyzer | 103–169 ms per photo; faces found in 3 of 5 previews (1, 3 and 4 faces); person-only subject in 2; EXIF (capture time incl. sub-second, flash, ISO, aperture, shutter, lens) read from the original HEICs without decoding pixels |
| Scene grouping | All 5 frames (90 s, same light) grouped as one scene after a fix: v0.5's first rule split the last frame on framing alone; visual change now needs time to pass as well (regression test added) |
| Full analysis, Natural / Balanced | 25.3 s wall for 5 photos at AI concurrency 2; 2–3 photos proposed, the rest left unchanged; largest change +0.20 EV / Shadows +16 |
| AI call cost | 6.1–10.3 s per photo; **19,472–25,774 input tokens** and 96–162 output tokens per 640-px preview — the Codex agent harness, not the image, dominates |
| Peak memory | 242 MB resident (largest process in the engine tree) |
| Repeatability, two identical runs | Decision agreement 4/5; exact-setting agreement (±0.1 EV, ±5 tone) 3/5; the model's under/ok/over judgment 5/5 |
| Lightroom writes | **Zero** |

What this shows: the read path, capability detection, measurement and planning work on real files at pilot scale, and the model's categorical judgments were stable while its numbers were not — which is why v0.5 uses measurements and scene medians for magnitudes. What it does not show: anything about RAW files (none in this selection, so the white-balance path has never run on real data), multiple scenes, or edit quality.

## First real writes (October 22, 2026 — run by the owner in the app)

Not the controlled sandbox protocol (G1): the owner applied a Natural / Balanced plan to 3 of the same 5 HEIC photos in their own catalog.

| Check | Result |
|---|---|
| Writes | 3 photos, one write each (Exposure; Exposure + Shadows; Shadows + Blacks) |
| Read-back verification | **3/3 verified**: intended values present, no other visible Develop field changed |
| Write + read-back time | 50–250 ms per photo |
| After-edit checks | 1 photo: Lightroom had no new preview yet ("error loading thumb"); 1 photo: face brightness rose 0.57 EV against an expected +0.10 EV, because the check predicted from Exposure alone while Shadows +10 also lifted the shaded faces (the check now skips frames whose tone sliders also changed) |
| Restore on real photos | **Not yet exercised** |
| White balance | **Not written**: the installed bridge cannot read or write Lightroom's relative white balance (`IncrementalTemperature/Tint`) used by HEIC/JPEG, confirmed from its published write schema |

## Real writes to date (owner-run, October 22, 2026)

| | Result |
|---|---|
| Develop writes | 16 (13 RAW, 3 HEIC) across 6 sessions |
| Verified by read-back | **16/16** |
| White-balance writes | 7, all on RAW (e.g. 4450 → 4820 K, tint 13 → 16; tint 14 → 6 from the measured cast), all verified |
| White-balance mode | Lightroom kept showing **As Shot** after a Temperature/Tint write (seen by the owner); the mock had wrongly flipped it to Custom. Fixed: every WB write now also sets Custom, and restore puts the original mode back in the same write. No real write has used the fix yet |
| Restores on real photos | 0 — not yet exercised |

**Colour-cast measurement** (read-only, analyzer on Lightroom previews): white surfaces on 4D6A8895 measure a* +2.6, b* −1.1 (white shirts, 17% of the frame); on 4D6A8913 a* +3.4, b* −2.7. With the colour-science conversion the plan for 4D6A8895 is Tint 14 → 8 (Balanced) / 6 (Stronger); before this change the AI called the skin natural and nothing was proposed. One real calibration point (tint −2 → white a* −0.27) is within a factor of ~2 of the theoretical slope (~0.30 a* per tint step); more paired before/after measurements are needed.

**Lightroom preview reliability:** "error loading thumb" occurred on several real requests minutes apart for photos that previewed fine earlier; retries now absorb it. On one CR3 all three requested sizes failed and the 320-px retry returned the full 5472 × 3648 image (3 MB), which went to the model. Previews are now capped at 1024 px locally: re-run read-only on the same photo with the integrated 0.6 build (bundled Node only on `PATH`, MCP bridge), the analyzer measured a 1024 × 682 preview and found 2 faces; 31 s wall (~20 s of it Lightroom's preview retries, 8 s AI, 26,229 input tokens), 244 MB peak.

## AI cost: one call per photo vs scene batches (October 22, 2026, read-only)

The user's selection was a single RAW (CR3) photo, so a real multi-photo scene could not be batched end to end. Four real `analyze` runs (two with `TONEPILOT_AI_BATCH=6`, two per photo) therefore all made one call per photo. The batch comparison used that photo's real Lightroom preview, sent through the engine's own `ai.mjs` and `harmonize.mjs` to the real Codex CLI: identical copies, and edited variants (−1 EV, +1 EV, warm cast, made with Core Image and measured by the real analyzer). Nothing was written; scratch sessions and previews were deleted afterwards.

| | One call per photo | Batch of 6 in one call |
|---|---|---|
| Input tokens per photo | 21,130–28,270 (typically ~22,000; 18 calls) | 5,500–7,390 (mean ~6,050; 8 calls) — **about −72%** |
| Model time per photo, sequential | 6.2–10.4 s (mean 8.3 s) | 17.8–25.3 s per call = 3.0–4.2 s per photo (mean 3.4 s) — **about −58%** |
| Same photo repeated (4 real engine runs) | 4/4 same decision and settings | — |
| Batch of identical copies vs per-photo answer | — | 36/36 within tolerance (±0.1 EV, ±100 K, ±3 tint) of a per-photo answer from the same run (6 calls) |
| Batch mixing different variants vs per-photo answer | per-photo repeats stable: 3/3 for each variant | Every answer attached to the right image (under/ok/over 12/12), but only **6/12 within tolerance**: the −1 EV frame got +0.52–0.56 EV instead of +0.32–0.36; the warm frame −420 K / tint 0 instead of −325 K / tint +3…+4 |

What this shows: batching removes most of Codex's fixed per-call prompt (~18,000 tokens on a trivial prompt) and the photo-to-answer mapping held. It also shows the model judges each image partly against the others in the same call, which changes magnitudes when frames differ. Whether that is better or worse is not measured. **Batching therefore stays off by default** (`TONEPILOT_AI_BATCH`, 1–6) until a real multi-photo scene shows equal decisions.

Other findings: `-c model_reasoning_effort="low"` made no measurable difference (same tokens, 7.3–9.6 s vs 8.5–9.5 s per photo, same decisions; Codex's catalog lists `low` as the default model's default effort), so it is not used. For this CR3, Lightroom failed the 640, 1024 and 640 px preview requests ("error loading thumb") and the 320 px retry returned the full 5472 × 3648 image (3 MB). Preview fetching took ~20 s of each ~32 s run.

## Simulated (automated, `node --test TonePilot/tests/*.test.mjs`)

121 tests, all passing, ~17 s. No photos and no catalog are touched. The workflow tests in `engine.test.mjs` and every recovery test run twice: against the mock MCP bridge and against a mock of TonePilot's own plug-in protocol.

| Suite | Covers |
|---|---|
| `engine.test.mjs` (20) | Guard limits incl. cumulative and mired caps; read-back classification; WB-mode restore; format capabilities; analyze-never-writes; confirmation; stale selection; unrelated manual edits; metadata edits; subset approval; unsupported files; no compounding across sessions; relaunch recovery |
| `recovery.test.mjs` + `recovery-plugin.test.mjs` (16 + 16) | Engine SIGKILLed after a write lands / before it lands; settle window; interrupted restore; manual edits after apply; bridge exits mid-apply; timeouts that land late / never; plug-in errors; rounding and side-effect mismatches; selection change mid-apply; app quit mid-apply; concurrent engines; torn and damaged journals; stopped-and-resumed analysis; AI outage fails resumably and retries |
| `analysis.test.mjs` (14) | Capture-time parsing across locales; scene splits; reframing vs real light change; tiny faces and small previews; scene exposure matching; outlier frames; strength scaling and thresholds; highlight protection; WB drift sync; mixed light; looks incl. preserved low-key/silhouette and creative colour; skin-hue warnings; schema normalization; oversized Lightroom previews scaled to 1024 px, never upscaled |
| `selection.test.mjs` (4) | Apply-time selection interlock: full reads O(n/N) (exact read counts asserted), a same-size swap stops the run within N photos and never writes outside the authorization, the rotating sample catches swaps early, reselecting resumes without double writes |
| `whitebalance.test.mjs` (17) | Relative (JPEG/HEIC) white balance proposed, written, verified and restored to As Shot; honest skip when the bridge can't write or can't read it; scene blending; model prompt; exposure-and-WB-only scope; looks named in explanations; skin-tone verdicts in Kelvin and relative units; colour-science slider directions; measured casts corrected when the AI calls skin natural; measurement sets the amount when it agrees with the AI; deliberate warm light left alone |
| `batch.test.mjs` (5) | Six photos of one scene in one model call, journaled per photo with shared-out token stats; a malformed batch answer falls back to one call per photo; batched and per-photo journals have the same records and decisions; a stopped batched analysis resumes without re-assessing finished photos; numbered batch prompt and strict schema |
| `plugin.test.mjs` (12) | TonePilot's plug-in: Lua allowlist equals the engine's keys and only eight actions exist; the Lua run against stub SDK objects (allowlist, ranges, JSON, token check, bridge file 0600, superseded instance) when a Lua interpreter is installed (skipped otherwise; CI has none); token required; client-side allowlist rejection; reconnect after dropped response connections; fallback to the MCP bridge with no or a stale bridge file; one Lightroom snapshot per photo before its first write, never blocking it; select mode; crop changes after analysis seen only through the plug-in; sessions that span both bridges |
| `bridgepatch.test.mjs` (2) | Bridge patch adds exactly two keys with backups, idempotent, refuses other versions |
| `bridge.test.mjs` (8) | Read-only selection, empty selection, over-limit selection, disconnected plug-in, unverified bridge version, pinned bridge, doctor completeness |
| `benchmark.test.mjs` (7) | Wilson intervals, blind-scoring requirement, small samples never "validated", interval-based gates, per-skin-group and lighting breakdowns, calibration threshold, repeatability |

**Mutation checks.** Reintroducing v0.4 defect A1 (treat an in-flight restore as finished) fails *interrupted restore is never reported as restored*; reintroducing A4 (pre-write check on changed keys only) fails *an unrelated manual edit … makes only that photo stale*.

**Bundled Node.js** (local build, October 22, 2026): `build.sh` bundled Node v22.23.4 after matching the SHA-256 in nodejs.org's `SHASUMS256.txt`. With no Node on `PATH` (`/usr/bin:/bin`), the bundled runtime ran `--mode sessions`; `--mode doctor` reported "Node 22.23.4 (bundled)", and with the app's `PATH` (bundled Node first) the Codex CLI, a Node script, passed its sign-in check. App size 31 MB → 138 MB. Under the hardened runtime (ad-hoc test signature) Node ran JIT code, WebAssembly and `fetch` with `allow-jit` alone and crashed on start without it. The app itself was not launched with the bundled runtime, and no Developer ID signing or notarization has run.

**Analyzer self-test** (`TonePilotAnalyzer --selftest`, run by every build): mid-grey linearity, clip fractions, monotonic headroom curve, sRGB → CIELAB accuracy, grid descriptor.

## Engine scaling (synthetic, `node TonePilot/Benchmarks/scale.mjs`)

| Photos | Scenes | Journal | Append (fsync) | Apply journaling | Scene grouping | Planning | Full fold | Heap |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 1 | 50 KB | 4.1 ms/record | 8.2 ms/photo | 3.5 ms | 3.4 ms | 3.7 ms | +0 MB |
| 100 | 3 | 248 KB | 4.1 ms/record | 8.0 ms/photo | 1.9 ms | 1.9 ms | 2.9 ms | +2 MB |
| 500 | 13 | 1.2 MB | 4.1 ms/record | 7.8 ms/photo | 5.9 ms | 6.4 ms | 21 ms | +6 MB |

End to end through the engine CLI and mock bridge at 20 photos (instant AI): 56 ms/photo to analyze, 48 ms per verified write including the after-edit check, 19 ms per restore.

Conclusion: the engine itself is not the bottleneck at 500 photos; AI latency and token cost are.

**Selection interlock.** v0.5.0 re-read the whole Lightroom selection before every write: n metadata rows per photo, O(n²) per apply. It now reads the full selection at the start, every 25 photos and before the last photo, and one sampled row otherwise (count plus one photo at a rotating position, escalating to a full read on any mismatch). Rows Lightroom must read during one apply, counted exactly:

| Photos | Before | Now |
|---:|---:|---:|
| 20 | 420 | 59 |
| 100 | 10,100 | 596 |
| 500 | 250,500 | 10,980 |

The trade-off: a selection change is now noticed within 25 photos (usually sooner, when the sample lands on a changed photo) instead of at the next photo. Writes in that window still go only to authorized photos and still pass the per-photo identity and staleness checks; the interlock signals the photographer's intent, it is not what prevents a wrong write.

## Not yet measured

- **TonePilot's own Lightroom plug-in (`TonePilot/LightroomPlugin`) has never run inside Lightroom.** Its Lua is syntax-checked with `luac` 5.5 (Lightroom embeds Lua 5.1) and exercised only against stub SDK objects; the engine is tested only against a mock of its protocol. Snapshot support (`createDevelopSnapshot`), the History step name, and whether any `full` Develop value changes without an edit are unverified.

- Any restore on real photos, and the controlled sandbox cycle (gate G1).
- Any multi-scene gallery; flash, tungsten or mixed light on real data.
- Photographic quality, acceptance, regressions, time saved (gate G3).
- Memory and responsiveness of Lightroom itself during a long job.
- Behaviour with Lightroom closed mid-job on real hardware (simulated only).
