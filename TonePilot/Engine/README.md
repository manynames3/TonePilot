# TonePilot Guarded Engine — v0.4

This is the first implementation of an independently validated Lightroom write boundary. It is **experimental** and must not be used on client catalogs without a recovery-tested backup.

## Operations

- inspect: read-only selected photo list.
- analyze: read-only metadata and Lightroom JPEG preview extraction, external AI assessment, conservative proposal validation and a private session plan. Zero Develop writes.
- apply: separate user approval, explicit confirmation, exact photo IDs and catalog path check, original-value match, strict setting and magnitude allowlist, one photo per write, Develop read-back, and unrelated-exposed-setting comparison.
- restore: explicit confirmation and conflict-aware restoration of only verified TonePilot-written values. Refuses to overwrite settings that a person changed afterward.

No model tool has direct access to Lightroom write methods. The analysis-only model sees a Lightroom-rendered preview and available Develop values; it returns structured suggested absolute slider values, checked by Engine/guard.mjs. Model confidence is not a calibrated probability.

Allowed writable controls: WhiteBalance (only Custom and only alongside an actual color change), Temperature (max 800K from baseline), Tint (max 12), Exposure2012 (max 0.75 EV), Highlights2012, Shadows2012, Whites2012, Blacks2012 (max 25 each). Hard slider ranges are validated. Crop, masks, profiles, HSL, retouching, metadata and ratings are not permitted.

## Session records

Each session is stored with owner-only access in the macOS Application Support/TonePilot/runs folder, with an atomic session JSON journal and a Markdown report. Baselines are written before analysis. Write progress states include write-started, write-returned and verified. If an ambiguous write occurs, the session stops as partial and requires checking in Lightroom; it does not claim an automatic safe rollback. A later restore only operates when the expected current values match the last verified writes.

The histogram helper TonePilotMetrics measures preview luma percentiles and clipping. This is limited to cached JPEG preview data, not RAW colorimetry or subject-aware grading. A read-back or image-hash change alone does not prove visual quality.

## Dependency boundaries

The bundle includes Engine JavaScript, guard logic, read-only selection scanner and a compiled Swift preview-metrics utility. It still requires Node.js, npx, Codex and the upstream Lightroom Classic MCP plug-in/server. It does NOT yet bundle those third-party runtimes or offer a notarized installer.

## Tests

- Mocked MCP bridge exercises analysis without writes, user-confirmed apply, verified read-back, restoration, changed-selection rejection, intervening manual-edit rejection and untouched-setting verification.
- Live read-only connection, metadata and previews were tested against five selected HEIC photos.
- Live cloud AI generated four conservative proposals and skipped one; no live writes occurred.
- Real catalog restoration, color accuracy, multi-scene consistency, large-gallery throughput and third-party quality comparisons remain unverified.

For independent scoring, use the Benchmark harness. Do not market acceptance rate or time saved before running blind held-out evaluations.
