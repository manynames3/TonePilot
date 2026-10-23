# Benchmarks

These tools summarize evidence; none of them can create it. There are still **no scored benchmark galleries**.

| Tool | Measures | Needs |
|---|---|---|
| `evaluate.mjs` | Blind acceptance, major regressions, review time vs any number of baselines; 95% Wilson intervals; paired McNemar test; breakdown by lighting and skin group; confidence calibration and an evidence-based threshold | Independently rated JSON (protocol in [docs/VALIDATION.md](../../docs/VALIDATION.md), gate G3) |
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

`"validated": true` requires at least 100 photos and the *interval*, not the point estimate, to clear each target: acceptance ≥ 85%, major regressions < 2%, ≥ 40% less review time than every baseline, and a significant paired advantage over at least one. Fewer than 100 photos exits with code 3.

Keep the evaluation set separate from anything used to tune thresholds, and keep client photos private.

## Choosing the AI provider and model — `compare-providers.mjs`

Read-only: it only runs `analyze`. Select the same photos in Lightroom, then analyze them with each provider and model, two or more times each:

```bash
node TonePilot/Benchmarks/compare-providers.mjs run --ids '["123","456"]' --runs 2 --out /tmp/tp-compare \
  --try codex --try bedrock:anthropic.claude-opus-5-5 --try bedrock:anthropic.claude-sonnet-5-5 \
  --price anthropic.claude-opus-5-5=<in>,<out> --price anthropic.claude-sonnet-5-5=<in>,<out>
```

Per provider and model: decision and setting agreement with the first one tried (the baseline), its own run-to-run repeatability, failures, input/output tokens and seconds per photo, and USD per photo when you pass `--price` (USD per million input/output tokens, from the current price list — none is assumed). `report <session-dir> …` recomputes this for sessions you already have. Agreement is not quality: pick candidates here, then judge them blind with `evaluate.mjs`. The output folder holds descriptions of client photos; delete it afterwards.
