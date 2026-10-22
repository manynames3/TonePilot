# TonePilot engine — v0.5

A Node.js process the Mac app launches for every operation. It is the only component that talks to Lightroom, and the only one that can write.

```text
Mac app ──args──▶ engine.mjs ──MCP/stdio──▶ Lightroom bridge 0.24.1 ──TCP──▶ Lightroom MCP plug-in ──SDK──▶ catalog
   ▲                 │
   └──JSONL events───┤── journal.jsonl (append-only, fsync)  ← single source of truth
                     ├── TonePilotAnalyzer (on-device faces, clipping, EXIF)
                     └── Codex CLI (read-only image assessment, strict JSON schema, no tools)
```

## Modes

| Mode | Lightroom | Lock | Purpose |
|---|---|---|---|
| `doctor [--live]` | read | no | Setup checklist with fixes |
| `inspect` | read | no | Current selection (IDs, filenames, formats) |
| `analyze --ids … --look … --strength … [--resume dir]` | read | yes | Baselines → measurements → scenes → AI → plan |
| `apply --session dir --confirm [--only ids]` | **write** | yes | Reconcile, then write approved edits one photo at a time |
| `restore --session dir --confirm [--only ids]` | **write** | yes | Undo this session's writes where untouched since |
| `reconcile --session dir` | read (+journal) | yes | Settle writes whose outcome was never recorded |
| `sessions`, `show --session dir` | none | no | Views rebuilt from journals |
| `discard --session dir --confirm` | none | yes | Hide a plan that changed nothing |

## Modules

| File | Responsibility |
|---|---|
| `engine.mjs` | Mode orchestration, stop handling, preview temp files |
| `journal.mjs` | Append-only fsync'd JSONL; torn-tail tolerant; corruption detection |
| `session.mjs` | Pure fold of journal records → session; **derived** status and safe actions; views |
| `guard.mjs` | Allowlist, slider ranges, per-session and cumulative caps (mired for WB), rounding, read-back classification, WB-aware restore plans, format capabilities |
| `lineage.mjs` | Each photo's pre-TonePilot origin across sessions |
| `lock.mjs` | One mutating engine at a time (PID + process check) |
| `policy.mjs` | Looks and strengths as numbers |
| `scenes.mjs` | Lighting-scene segmentation and reference frames |
| `harmonize.mjs` | Scene-consistent, policy-bounded decisions |
| `ai.mjs` | Prompt, strict output schema, Codex subprocess, bounded pool |
| `lightroom.mjs` | MCP client; pinned/bundled bridge; typed errors; apply-time selection interlock (`SelectionGuard`) |
| `doctor.mjs` | Diagnostics |
| `Analyzer.swift` | On-device measurements of Lightroom-rendered previews |

## Safety invariants

1. **Analysis never writes.** Only `apply`/`restore` call `set_develop_settings`, only with `--confirm`, only for IDs in the session journal.
2. **Intent before action.** `write-intent` (with the full pre-write state) is fsync'd before the write is sent; `write-result` records what read-back showed. A crash between them leaves the photo `writing`, and the session `interrupted`, until `reconcile` decides from real values.
3. **Never assume a write failed early.** An unconfirmed write is not called "not applied" until `TONEPILOT_SETTLE_MS` (60 s) after it was sent.
4. **Never overwrite the photographer.** Any change to a photo's exposed Develop state between analysis and apply makes it stale (skipped). Restore only touches keys TonePilot wrote and only if they still hold TonePilot's values.
5. **Never claim more than read-back proves.** `verified` = intended values present and nothing else visible changed; otherwise `mismatch` for review.
6. **No compounding.** Caps apply from the photo's origin across all sessions.
7. **Status is derived, never stored.** "Restored" means every photo with a TonePilot change is restored.
8. **Selection interlock without O(n²) reads.** Apply reads the full selection at the start, every 25 photos and before the last; other photos cost one sampled row. A changed selection stops the run within 25 photos, usually sooner. Per-photo identity and staleness checks — not the interlock — are what keep writes on the right photos.

Limits of the bridge: it exposes ~25 Develop fields. Masks, crop, profile, lens and calibration cannot be checked through it; TonePilot never sends them.

## Journal records

`session-created`, `photo-baseline`, `photo-unsupported`, `photo-measured`, `scenes`, `photo-assessed`, `photo-proposed`, `plan-ready`, `analysis-failed`, `analysis-resumed`, `apply-started`, `photo-stale`, `write-intent`, `write-result`, `post-check`, `apply-finished`, `restore-started`, `restore-conflict`, `restore-intent`, `restore-result`, `restore-finished`, `session-error`, `discarded`. Unknown types are ignored (forward compatible).

Photo states: `pending → baselined → proposed | skipped | flagged | unsupported → (stale) | writing → applied | apply-mismatch | apply-failed → restoring → restored | restore-mismatch`.

## Decision pipeline

1. **Measure** each Lightroom-rendered preview on device: dominant faces' linear brightness and CIELAB skin colour, highlight headroom (fraction of pixels that would clip at +0.05 … +1.0 EV), a 4×4 Lab descriptor, EXIF from the original file.
2. **Group scenes** in capture order. Hard splits: camera body, flash on/off, > 30 min. Soft cues (scored): > 5 min, metered light change, as-shot WB change, surroundings — the last only counts fully once time has passed.
3. **Assess** with the model: illuminant, mixed light, backlight, intent, skin cast, subject exposure, proposed values, confidence — strict JSON.
4. **Decide** per scene: gate by confidence and intent; exposure target = median of the agreeing frames' implied face brightness; WB = scene median in mired, or AWB-drift sync; tone = own proposal blended with the scene median, plus the look's bias; every value scaled by strength, dead-banded, clip-guarded, clamped from origin, then re-validated by `guard.mjs`.

## Environment

`TONEPILOT_RUNS_DIR`, `TONEPILOT_CODEX`, `TONEPILOT_ANALYZER`, `TONEPILOT_MCP_SERVER` (bundled bridge), `TONEPILOT_PARENT_PID`, `TONEPILOT_SETTLE_MS`, `TONEPILOT_AI_CONCURRENCY` (1–4, default 2), `TONEPILOT_WRITE_TIMEOUT_MS`, `TONEPILOT_SELECTION_FULL_EVERY` (default 25). Tests also use `TONEPILOT_NPX` / `TONEPILOT_MCP_ARGS` to substitute the mock bridge.
