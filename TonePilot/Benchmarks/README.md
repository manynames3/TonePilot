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
