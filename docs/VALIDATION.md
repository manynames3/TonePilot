# Validation gates

TonePilot moves forward only when a gate passes with real evidence. Status as of v0.5.0 (October 22, 2026).

| Gate | What it proves | Status |
|---|---|---|
| G0 | Safety logic under failure, simulated | **Passed** — 149 automated tests, mutation-checked |
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

3. The script refuses unless every selected photo's file is inside the sandbox folder. Then, stopping at the first FAIL:
   - live doctor (Lightroom/plug-in checks count as proven by the script's own live reads) → analyze (Subtle) → apply; every approved edit must be verified;
   - independent read-back: at least one real nonzero Exposure2012 write and, when any photo is RAW, at least one real Temperature/Tint write (counts in the report); RAW white-balance writes must show WhiteBalance "Custom";
   - **simulated photographer edit**: one direct `set_develop_settings` on one sandbox photo changes its Exposure2012; restore must report that photo as a conflict and leave the edit untouched, while every other photo returns to its original WB mode, Temperature/Tint and byte-identical Develop fields;
   - the photographer puts TonePilot's value back → restore → every photo byte-identical to the original, WhiteBalance included;
   - analyze again, SIGKILL the engine right after its first write intent → reconcile (waits while Lightroom settles) → restore → no photo left unconfirmed or changed, originals intact.

   The JSON report lists the bridge kind and version, the Lightroom version when the bridge reports it, the Develop fields observed and every step's PASS/FAIL; overall PASS only if all pass. Pick photos that need both exposure and white-balance correction (e.g. tungsten-lit RAWs), or the write-count step fails. `tests/sandbox-cycle.test.mjs` runs the script against the mock Lightroom.
4. Manually, in Lightroom: confirm each TonePilot write appears in the History panel.

**Pass:** overall PASS, zero drift, History shows only TonePilot's own steps and the two simulated edits.

## G2 — real read-only analysis

At least three real RAW galleries (different bodies, including one wedding with window light, flash and tungsten), 20 photos per pass. Record per pass: scenes found vs the photographer's own split, proposals, flags, wall time, tokens. **Pass:** scene splits match the photographer's judgment ≥ 90% of boundaries; no proposal outside policy; no crash.

## G3 — blind photographic benchmark

1. Hold out ≥ 100 photos (target 500) that were never used to tune TonePilot: RAW from several bodies; diverse natural skin tones; window, open shade, golden hour, flash, tungsten, mixed light; white dresses and backlight; some with the photographer's own preset already applied.
2. For each photo, produce: TonePilot's first pass, Lightroom Auto, the photographer's preset/AI-profile output (Narrative / Aftershoot / Imagen where available), and the photographer's final edit as reference.
3. Export randomized, unlabelled JPEGs. Two or more professional raters score each: *accepted without substantial correction* (yes/no), *major colour or exposure regression* (yes/no), and actual minutes to finish.
4. Record skin group and lighting category per photo; keep TonePilot's model confidence.
5. `node TonePilot/Benchmarks/evaluate.mjs scored.json`

**Pass ("validated")**: ≥ 100 photos; lower 95% bound of acceptance ≥ 85%; upper bound of major regressions < 2%; ≥ 40% less time than every baseline; a statistically significant paired advantage (McNemar p < 0.05) over at least one baseline; no skin group materially worse than the others. The tool refuses to call smaller samples validated.

- **Skin groups** (gate `everySkinGroupAssessedAndAtLeast75`): at least two recorded groups, each with ≥ 30 photos and an acceptance lower 95% bound ≥ 75% (10 points under the target), so a strong average can never hide a weak group. A group under 30 photos, or photos with no skin group recorded (`unspecified`), is reported as `insufficient` and blocks validation rather than passing silently; a group below the floor is `below-floor`. In practice a 30-photo group needs ≥ 28 accepted, a 50-photo group ≥ 44.
- **Regressions:** with zero major regressions, the Wilson upper bound first drops below 2% at **189 photos** (0/189 → 1.992%; 0/188 → 2.002%). So the 100-photo minimum cannot pass the regression gate; plan for ≥ 189, more if any regression is expected.
- **Input errors** (exit 1, nothing is scored): duplicate photo ids, a photo without an id, or a photo missing a score for any method that appears anywhere in the file.

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
