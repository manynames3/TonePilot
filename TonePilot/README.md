# TonePilot macOS — source and development

The native Editorial Studio interface remains a lightweight Lightroom Classic companion. v0.4 adds a **review-before-apply** editing pipeline rather than allowing a free-form AI agent to write Develop settings.

The app uses:
- Source/TonePilotApp.swift — macOS SwiftUI controls, review confirmation, session restoration interface.
- Source/WorkspaceModel.swift — Lightroom selection, process/status management, private session history.
- Engine/engine.mjs — read-only analysis, guarded apply, verification and conditional restoration.
- Engine/guard.mjs — explicit Develop-setting allowlist, bounded corrections and independent unchanged-setting checks.
- Engine/lightroom.mjs — local MCP JSON-RPC bridge, with timeouts and selection validation.
- Engine/ImageMetrics.swift — local preview histogram and clipping measurements.
- scan-selection.mjs — fast direct read-only selection scanner.
- tests/ — isolated mocked Lightroom and AI tests.
- Benchmarks/ — protocol and harness for real blind photographic evaluation.

## Build

Run TonePilot/build.sh from the repository root. The build places the complete native application bundle in your user Applications folder, bundles the guarded engine and preview metrics helper, and ad-hoc signs the app. It is NOT notarized.

The app stores editable session reports and plans in your macOS user Application Support/TonePilot/runs directory—not alongside the Git source. This includes filenames and relevant settings; the contents must be treated as private client data.

Run all test suites using Node's test runner over TonePilot/tests/*.test.mjs.

## Verified today

- The Mac app builds and opens with its native UI.
- The Lightroom MCP bridge returns real selection IDs, Develop metadata and rendered JPEG previews.
- A read-only five-HEIC cloud AI pilot produced four proposed changes and one skipped photo; **none were applied**.
- The simulated full write/verify/restore process and multiple safety failure tests pass.

**Not verified:** actual Develop writes in a real sandbox Lightroom catalog, objective color/skin accuracy, client-safe restoration, quantified time savings, scale beyond 20 photos, and notarized distribution. Do not charge for this as a finished editing product.
