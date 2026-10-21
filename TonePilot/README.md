# TonePilot macOS source

This directory contains the SwiftUI app and the read-only Lightroom MCP selection scanner.

**Start with the [main project README](../README.md)** for product overview, architecture, developer setup, AI/cloud disclosure, and known limitations.

- `Source/TonePilotApp.swift`: compact native user interface and menu-bar helper.
- `Source/WorkspaceModel.swift`: Lightroom connection checks, selection scan, editing orchestrator, and session reports.
- `scan-selection.mjs`: direct, read-only Lightroom MCP selection request (does not call Codex or edit photographs).
- `build.sh`: builds the local `~/Applications/TonePilot.app` bundle.

**Prototype warning:** the UI and Codex launch path are implemented, but end-to-end Develop adjustments have not been validated. Always use test photographs and back up the Lightroom catalog.
