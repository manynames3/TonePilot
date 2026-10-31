# Benchmarks

These tools summarize evidence; none of them can create it. There are still **no scored benchmark galleries**.

| Tool | Measures | Needs |
|---|---|---|
| `evaluate.mjs` | Blind acceptance, major regressions, review time vs any number of baselines; 95% Wilson intervals; paired McNemar test; breakdown by lighting and skin group; confidence calibration and an evidence-based threshold | Independently rated JSON (protocol in [docs/VALIDATION.md](../../docs/VALIDATION.md), gate G3) |
| `owner-review.mjs` | The owner's own better/same/worse rating of exposure and white balance per photo (owner pilot, not validation) | A session folder |
| `repeatability.mjs` | How often identical analyses of the same photos agree | Two or more session folders |
| `scale.mjs` | Engine journaling, folding, grouping and planning cost at 20/100/500 photos; engine overhead end to end | Nothing (synthetic) |

## evaluate.mjs input

```json
{
  "blinded": true,
  "photos": [{
    "id": "wedding3-0412",
    "category": {"lighting": "window", "skin": "V-VI"},
    "confidence": 0.86,
    "scores": {
      "tonepilot":      {"accepted": true,  "majorRegression": false, "reviewMinutes": 0.4},
      "lightroom-auto": {"accepted": false, "majorRegression": false, "reviewMinutes": 1.6},
      "aftershoot":     {"accepted": true,  "majorRegression": false, "reviewMinutes": 0.7}
    }
  }]
}
```

`"validated": true` requires at least 100 photos and the *interval*, not the point estimate, to clear each target: acceptance ≥ 85%, major regressions < 2%, ≥ 40% less review time than every baseline, a significant paired advantage over at least one, and every skin group (≥ 2 groups, ≥ 30 photos each) with an acceptance lower bound ≥ 75%. Zero regressions need ≥ 189 photos to bound the rate under 2%. Fewer than 100 photos exits with code 3; duplicate ids or missing scores exit with code 1.

Keep the evaluation set separate from anything used to tune thresholds, and keep client photos private.

## Owner pilot — `owner-review.mjs`

Read-only: it reads a session journal and never talks to Lightroom. You rate TonePilot's result on your own session while looking at the photos in Lightroom:

```bash
node TonePilot/Benchmarks/owner-review.mjs start <session-dir> --out ~/tonepilot-review.json   # creates, or resumes
node TonePilot/Benchmarks/owner-review.mjs rate ~/tonepilot-review.json
node TonePilot/Benchmarks/owner-review.mjs report ~/tonepilot-review.json
```

Every photo is listed, including unchanged, flagged and unsupported ones, with TonePilot's state and changes. For each you answer exposure and white balance — better / same / worse / na (b/s/w/n) — and an optional short reason. Each answer is saved at once, so you can stop and run `rate` again later. `report` counts each answer separately for exposure and white balance and lists the photos rated worse, with reasons. It is one photographer, not blind: an **owner pilot, not validation**. The file (0600) holds filenames and your notes: keep it private.

## Choosing the AI provider and model — `compare-providers.mjs`

Read-only: it only runs `analyze`. Select the same photos in Lightroom, then analyze them with each provider and model, two or more times each:

```bash
node TonePilot/Benchmarks/compare-providers.mjs run --ids '["123","456"]' --runs 2 --out /tmp/tp-compare \
  --try codex --try bedrock:anthropic.claude-opus-5-5 --try bedrock:anthropic.claude-sonnet-5-5 \
  --price anthropic.claude-opus-5-5=<in>,<out> --price anthropic.claude-sonnet-5-5=<in>,<out>
```

Per provider and model: decision and setting agreement with the first one tried (the baseline), its own run-to-run repeatability, failures, input/output tokens and seconds per photo, and USD per photo when you pass `--price` (USD per million input/output tokens, from the current price list — none is assumed). `report <session-dir> …` recomputes this for sessions you already have. Agreement is not quality: pick candidates here, then judge them blind with `evaluate.mjs`. The output folder holds descriptions of client photos; delete it afterwards.

## How close is TonePilot to your own edits? — `vs-photographer.mjs`

Read-only. Lightroom has one catalog open at a time, so it runs in two steps:

1. **Main catalog:** select 30–50 photos you have already finished, then
   `node TonePilot/Benchmarks/vs-photographer.mjs capture --out ~/tonepilot-reference.json`
   to record each photo's final white balance and exposure. Nothing is changed.
2. **Test catalog** (File → New Catalog) with fresh, unedited copies of the same files: select them, run TonePilot's analysis (any AI service), then
   `node TonePilot/Benchmarks/vs-photographer.mjs compare ~/tonepilot-reference.json <session-dir>`.

Per setting it reports how far the unedited photo was from your value, how far TonePilot's plan is, how many photos it moved closer or further, wrong-direction moves, and changes where you made none. Your edit may also use profiles, curves or masks, so this measures direction and distance, not taste. The reference file holds filenames: keep it private and delete it afterwards.

## Automated quality proxy — `auto-judge.mjs`

Read-only and unattended. For each photo a session would change, it renders an approximate "after" of the exposure and RAW white-balance change on the Mac (`render.swift`, Core Image — not Lightroom's renderer) and asks a judge model from a different family than the assessor to pick the more natural of before/after, shown in random order, or "same". Every photo also gets two controls: an identical pair (should be "same") and a deliberately wrong edit (+1 EV, +900 K, +12 tint — should lose).

```bash
node TonePilot/Benchmarks/auto-judge.mjs <session-dir> --judge bedrock:global.anthropic.claude-sonnet-4-6 --out judge.json
```

First real run (10 RAW photos, Claude Sonnet 4.6 on Bedrock): the judge rejected 10/10 wrong edits but called identical pairs "same" only 6/10, so it detects gross errors and cannot resolve TonePilot's small corrections (5 better / 3 worse was within its noise). Use it as a gross-error alarm, not a quality score. The output names photos and quotes the judge's descriptions: keep it private.

## Fresh assessments and the next owner calibration

Normal passes now reuse matching assessments. For independent model comparisons, run each analysis with `--fresh-assessment`; `compare-providers.mjs run` does this automatically. `repeatability.mjs` refuses sessions with reused judgments so it cannot report cached answers as fresh-model agreement.

Start the owner calibration with about 20 RAW copies using the usual preset/profile. Capture the photographer's finished settings with `vs-photographer.mjs capture`, analyze matching copies in passes of at most 20, then compare and rate using `owner-review.mjs`. Keep those pilot photos separate from the held-out blind evaluation. The tools record evidence; thresholds and slider response are not calibrated until those ratings exist. Real writes/restores remain restricted to the approved G1 sandbox protocol.
