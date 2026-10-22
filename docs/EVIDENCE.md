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

## Simulated (automated, `node --test TonePilot/tests/*.test.mjs`)

55 tests, all passing, ~15 s. No photos and no catalog are touched.

| Suite | Covers |
|---|---|
| `engine.test.mjs` (12) | Guard limits incl. cumulative and mired caps; read-back classification; WB-mode restore; format capabilities; analyze-never-writes; confirmation; stale selection; unrelated manual edits; metadata edits; subset approval; unsupported files; no compounding across sessions; relaunch recovery |
| `recovery.test.mjs` (16) | Engine SIGKILLed after a write lands / before it lands; settle window; interrupted restore; manual edits after apply; bridge exits mid-apply; timeouts that land late / never; plug-in errors; rounding and side-effect mismatches; selection change mid-apply; app quit mid-apply; concurrent engines; torn and damaged journals; stopped-and-resumed analysis; AI outage fails resumably and retries |
| `analysis.test.mjs` (13) | Capture-time parsing across locales; scene splits; reframing vs real light change; tiny faces and small previews; scene exposure matching; outlier frames; strength scaling and thresholds; highlight protection; WB drift sync; mixed light; looks incl. preserved low-key/silhouette and creative colour; skin-hue warnings; schema normalization |
| `bridge.test.mjs` (7) | Read-only selection, empty selection, over-limit selection, disconnected plug-in, unverified bridge version, pinned bridge, doctor completeness |
| `benchmark.test.mjs` (7) | Wilson intervals, blind-scoring requirement, small samples never "validated", interval-based gates, per-skin-group and lighting breakdowns, calibration threshold, repeatability |

**Mutation checks.** Reintroducing v0.4 defect A1 (treat an in-flight restore as finished) fails *interrupted restore is never reported as restored*; reintroducing A4 (pre-write check on changed keys only) fails *an unrelated manual edit … makes only that photo stale*.

**Analyzer self-test** (`TonePilotAnalyzer --selftest`, run by every build): mid-grey linearity, clip fractions, monotonic headroom curve, sRGB → CIELAB accuracy, grid descriptor.

## Engine scaling (synthetic, `node TonePilot/Benchmarks/scale.mjs`)

| Photos | Scenes | Journal | Append (fsync) | Apply journaling | Scene grouping | Planning | Full fold | Heap |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 1 | 50 KB | 4.1 ms/record | 8.2 ms/photo | 3.5 ms | 3.4 ms | 3.7 ms | +0 MB |
| 100 | 3 | 248 KB | 4.1 ms/record | 8.0 ms/photo | 1.9 ms | 1.9 ms | 2.9 ms | +2 MB |
| 500 | 13 | 1.2 MB | 4.1 ms/record | 7.8 ms/photo | 5.9 ms | 6.4 ms | 21 ms | +6 MB |

End to end through the engine CLI and mock bridge at 20 photos (instant AI): 56 ms/photo to analyze, 48 ms per verified write including the after-edit check, 19 ms per restore.

Conclusion: the engine itself is not the bottleneck at 500 photos. AI latency and token cost are, and the per-write selection re-check reads the whole selection each time (O(n²) at 500) — that must change before gate G4.

## Not yet measured

- Any real Develop write, verification or restore (gate G1).
- Any RAW file; any multi-scene gallery; flash, tungsten or mixed light on real data.
- Photographic quality, acceptance, regressions, time saved (gate G3).
- Memory and responsiveness of Lightroom itself during a long job.
- Behaviour with Lightroom closed mid-job on real hardware (simulated only).
