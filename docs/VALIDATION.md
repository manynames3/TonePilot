# Validation gates

TonePilot moves forward only when a gate passes with real evidence. Status as of v0.5.0 (October 22, 2026).

| Gate | What it proves | Status |
|---|---|---|
| G0 | Safety logic under failure, simulated | **Passed** — 138 automated tests, mutation-checked |
| G1 | Real writes, verification and restore on a disposable catalog | **Not run** — needs the photographer's go-ahead and a sandbox catalog |
| G2 | Real read-only analysis on representative RAW galleries | **Partial** — 5 HEIC photos, one scene; a few single RAW photos; no RAW gallery yet |
| G3 | Photographic quality, blind | **Not run** — needs ≥ 100 held-out photos and independent raters |
| G4 | Scale: 20 → 100 → 500 photos | **Not started** — 20-photo limit stays |
| G5 | Distribution: Developer ID signing, notarization, dependency bundling | **Prepared** — scripts ready, no credentials used |
| G6 | Repeatability | **Measured, below target** — 80% decision agreement on 5 photos × 2 runs |

## G1 — controlled real-write cycle

Requires explicit authorization. Never run on client work.

1. In Lightroom Classic: **File → New Catalog** → `TonePilot-Sandbox.lrcat`. Import 3–5 *copies* of RAW test photos into `~/Pictures/TonePilot-Sandbox/` (the folder name is enforced). Back the catalog up.
2. Select the photos, then run:

   ```bash
   node TonePilot/tests/live/sandbox-cycle.mjs --i-have-a-backup
   ```

3. The script refuses unless every selected photo's file is inside the sandbox folder. It then: runs the live doctor → analyzes (Subtle) → applies → independently re-reads every value → restores → checks every exposed Develop field is byte-identical to the original → analyzes again, SIGKILLs the engine immediately after its first write intent → reconciles → restores → re-checks originals. A JSON report is written.
4. Manually, in Lightroom: confirm each TonePilot write appears in the History panel, then edit one restored-able photo by hand and confirm TonePilot refuses to restore it.

**Pass:** every step PASS, zero drift, History shows only TonePilot's own steps.

## G2 — real read-only analysis

At least three real RAW galleries (different bodies, including one wedding with window light, flash and tungsten), 20 photos per pass. Record per pass: scenes found vs the photographer's own split, proposals, flags, wall time, tokens. **Pass:** scene splits match the photographer's judgment ≥ 90% of boundaries; no proposal outside policy; no crash.

## G3 — blind photographic benchmark

1. Hold out ≥ 100 photos (target 500) that were never used to tune TonePilot: RAW from several bodies; diverse natural skin tones; window, open shade, golden hour, flash, tungsten, mixed light; white dresses and backlight; some with the photographer's own preset already applied.
2. For each photo, produce: TonePilot's first pass, Lightroom Auto, the photographer's preset/AI-profile output (Narrative / Aftershoot / Imagen where available), and the photographer's final edit as reference.
3. Export randomized, unlabelled JPEGs. Two or more professional raters score each: *accepted without substantial correction* (yes/no), *major colour or exposure regression* (yes/no), and actual minutes to finish.
4. Record skin group and lighting category per photo; keep TonePilot's model confidence.
5. `node TonePilot/Benchmarks/evaluate.mjs scored.json`

**Pass ("validated")**: ≥ 100 photos; lower 95% bound of acceptance ≥ 85%; upper bound of major regressions < 2%; ≥ 40% less time than every baseline; a statistically significant paired advantage (McNemar p < 0.05) over at least one baseline; no skin group materially worse than the others. The tool refuses to call smaller samples validated.

Calibration: the same file yields a reliability table and the lowest model-confidence threshold whose acceptance lower bound clears 85%. Replace the strength thresholds in `policy.mjs` with calibrated ones only from this output.

## G4 — scale

Raise `MAX_JOB_PHOTOS` (guard.mjs) 20 → 100 only after: G1 passed; ~~the per-write selection re-check is made cheap~~ (done: `SelectionGuard` reads the full selection at the start, every 25 photos and before the last, and one sampled row otherwise — 10,980 rows instead of 250,500 at 500 photos); AI concurrency and cost measured on a real 100-photo run; Lightroom stays responsive (measure UI latency) and TonePilot's memory stays < 500 MB. Repeat for 100 → 500 with a resumable, batch-checkpointed analysis.

## G5 — distribution

```bash
TONEPILOT_SIGN_IDENTITY="Developer ID Application: …" TONEPILOT_APP_PATH=dist/TonePilot.app ./TonePilot/build.sh
TONEPILOT_NOTARY_PROFILE=tonepilot-notary ./TonePilot/notarize.sh dist/TonePilot.app
```

Remaining before a normal photographer can install it (Node.js is now bundled): replace the Codex CLI dependency with a direct model API or account flow, and a guided plug-in installer.

## G6 — repeatability

Analyze the same 50 photos three times: `node TonePilot/Benchmarks/repeatability.mjs <dirs…>`. **Target:** ≥ 90% decision agreement and ≥ 80% exact-setting agreement. Current (5 photos × 2): 80% / 60%.
