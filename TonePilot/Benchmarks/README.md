# TonePilot blind quality benchmark

The evaluation harness prevents invented performance claims. There are currently no scored benchmark galleries.

## Procedure

1. Collect at least 100 held-out RAW photos, ideally 500+, covering diverse camera systems, complex lighting and natural skin tones.
2. Independently render TonePilot and baseline results from the same originals. Include Lightroom Auto and a meaningful paid competitor where possible.
3. Blind the source editor, randomize image order and obtain independent professional ratings.
4. Record per-image acceptance without substantial re-editing, presence of major color or exposure regressions, and actual correction/review minutes.
5. Keep the data set separate from the tuning set and all client data private.
6. Run the evaluation harness using the actual scored JSON file.

Command:

    node TonePilot/Benchmarks/evaluate.mjs /path/to/independently-scored-gallery.json

The JSON must contain a top-level blinded=true and photos array, each entry having id and scores.tonepilot and scores.baseline. Each score must include accepted (boolean), majorRegression (boolean) and reviewMinutes (nonnegative number).

Proposed benchmark goals: 85% accepted, fewer than 2% major regressions, at least 40% lower editing/review time, and improved acceptance versus the chosen baseline. These are targets, not achieved results. The program exits unsuccessfully for fewer than 100 evaluated images.

Safety testing is separate: out-of-scope photo IDs, unexpected Develop keys, changed selections, catalog identity changes, interrupted writes, rollback conflicts, and correct cancellation. A real Lightroom recovery exercise is required before marketing the feature.
