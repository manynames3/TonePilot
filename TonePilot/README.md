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

**Experimental:** Lightroom selection syncing is implemented, but the current Lightroom MCP server has not yet been connected successfully. Do not run real edits without catalog backups and a successful pilot.
