# TonePilot contributor and agent instructions — v0.4

TonePilot is a **Lightroom Classic companion**. It is NOT a RAW editor, catalog manager, photo viewer or image-export application.

## Critical safety contract

- **Do not instruct a general-purpose model to call Lightroom write tools directly.** The prior direct Codex-MCP editing workflow is deprecated.
- All Develop writes must go through TonePilot/Engine/engine.mjs, using the validation and allowlist in Engine/guard.mjs.
- First stage **analyze** is strictly read-only. All AI proposals are saved to a private session plan. The user must separately review and explicitly confirm **apply**.
- Selected photo IDs must match exactly; the engine also checks source file identity and original Develop settings before writing.
- Only allowed settings: WhiteBalance, Temperature, Tint, Exposure2012, Highlights2012, Shadows2012, Whites2012 and Blacks2012; only enabled groups can be changed. No crop, masking, presets, HSL, metadata, ratings, export or deletion.
- Change size and confidence are limited. A model recommendation is NOT permission to exceed those bounds.
- Save the original settings and preview hashes before analysis. Persist write intent before each write; verify Develop values after every write; independently check other Lightroom-exposed Develop controls remain unchanged.
- Restoration is conditional on the current values still matching the specific verified changes TonePilot made; never overwrite manual Lightroom edits made afterward.
- Never use any dangerous sandbox bypass flag to solve a permission problem.
- NEVER modify a real Lightroom catalog through code tests unless an explicitly approved, backed-up test pilot.

## Product truthfulness

- Actual cloud image analysis was verified on five selected HEIC previews in October 2026: four proposed edits, one skipped; **zero live Develop writes**.
- Real-image edit quality, post-apply Lightroom behavior and client-catalog rollback are NOT proven. Do not claim production readiness, time saved or benchmark outcomes.
- Model confidence is heuristic, not calibrated. AI visual opinions must be checked on representative scenes by independent photographers.
- Some non-RAW photos expose no numeric Kelvin/Tint in the Lightroom bridge. Skip unavailable keys.
- The metrics utility measures JPEG luminance/clipping only; it cannot certify accurate skin tones or professional color.
- Cloud AI processes Lightroom-rendered JPEGs and relevant Develop values; client-photo consent and provider data privacy must be considered.

## Engineer workflow

1. Run Node test runner against all TonePilot/tests/*.test.mjs files before committing.
2. Build with TonePilot/build.sh; verify ad-hoc signature and self-contained Engine resources.
3. Use Engine inspect mode for harmless live connection tests. Do not apply or restore on valuable photos.
4. Back up Lightroom and use disposable test images before a controlled real edit.
5. Preserve public documentation caveats about quality, setup and third-party integrations.
6. Never commit originals, Lightroom catalogs, private App Support sessions, logs, credentials or user data.
7. Public screenshots show the app, not verified AI-edited photo results.

## Remaining roadmap

Keep Lightroom as the review and before/after workspace. Prioritize quality benchmarks and calibration, sandbox-catalog recovery tests, reliable interrupted-session UX, one-click installer and onboarding, and measured gallery throughput. Login/authentication features remain out of scope.
