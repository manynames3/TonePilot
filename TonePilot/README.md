# TonePilot macOS — SwiftUI developer source

The native **Editorial Studio** interface lives in `Source/TonePilotApp.swift`. The supporting Lightroom selection scanner and Codex AI editing controller are implemented in `scan-selection.mjs` and `Source/WorkspaceModel.swift`.

Build and launch:

```bash
./TonePilot/build.sh
open ~/Applications/TonePilot.app
```

Run the read-only scanner tests:

```bash
node --test TonePilot/tests/selection-scanner.test.mjs
```

For requirements, plugin setup, safety limitations, and development status see the [project README](../README.md).

**Experimental:** Read-only selection syncing was verified with five photos on October 21, 2026; Codex MCP access was also verified after automatic approval review. Actual Develop edits have **not** yet been validated. Do not run real edits without catalog backups and a successful pilot.

## v0.3.1 reliability patch

- The native app launches Codex with automatic approval review and the workspace-write sandbox.
- Codex execution now completes on process termination, even if child MCP servers keep stdout open.
- Blocked and incomplete sessions no longer appear as successful editing sessions.
- AI photo edits still require validation on test images and a backed-up catalog.
