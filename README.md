# TonePilot

**AI-assisted first-pass editing for Adobe Lightroom Classic — without replacing Lightroom.**

TonePilot is a lightweight, native macOS companion that helps photographers automate the repetitive first pass of a photo edit: **white balance, tint, skin-tone casts, exposure, and tonal consistency**. Select photographs in Lightroom, choose a correction style in TonePilot, and review the resulting **nondestructive Develop adjustments in Lightroom Classic**.

**Early prototype (v0.1).** The macOS app builds and launches, and the Lightroom/MCP/Codex workflow is wired in code. **An end-to-end AI edit has not yet been successfully validated.** Please do not use this build unattended on client or irreplaceable catalogs.

> **TonePilot is not a RAW processor, catalog manager, photo viewer, or Lightroom replacement.** Lightroom remains the place to view, develop, compare, and export your photographs.

## At a glance

- **Native macOS companion** built with SwiftUI; compact window and menu-bar entry.
- **Works with your existing Lightroom catalog** through the independent [Lightroom Classic MCP bridge](https://github.com/Automaat/lightroom-mcp).
- **AI editing orchestration through Codex CLI**, using your own authenticated, cloud-backed model configuration — no built-in local LLM or separate TonePilot AI API yet.
- **Focused adjustment controls:** white balance/skin-tone casts, exposure, and highlights/shadows; Natural, Soft & Airy, or Scene Mood look; conservative adjustment strength.
- **Explicit photo selection** read from Lightroom, with a **20-photo pilot limit** and a selected-ID check before edits.
- **First-pass audit trail:** the agent is instructed to save original Develop settings, apply restrained corrections, recheck previews, and produce an edit/review report. Lightroom's Develop History remains the definitive place to inspect or undo changes.
- **No duplicated photo preview library** and no automatic export.

## Current development status

| Area | Status |
| --- | --- |
| SwiftUI app, compact workspace, menu-bar launcher | Implemented and locally launched |
| Lightroom Classic and Codex detection | Implemented |
| Lightroom MCP plugin installation and Codex MCP registration | Tested on a local development Mac |
| Read-only selection scanner via Lightroom MCP | Implemented; **live connection not yet verified** |
| Run AI First Pass button → Codex agent → Lightroom tools | Implemented orchestration; **real photo editing not end-to-end tested** |
| Automated, reliable white-balance/skin-tone and exposure evaluation | Experimental; **no measured quality benchmark yet** |
| Baseline logging, Develop snapshots, preview rechecks, review report | Agent instructions exist; **not yet verified on actual edits** |
| 200+ photo unattended batch processing | Not supported in this prototype |
| Notarized installer / distribution-ready build | Not available |

**Last bridge check:** the Lightroom MCP client returned *“Lightroom plugin not connected”*. This is a runtime setup blocker; it is not evidence that AI corrections have already been tested.

## How it works

~~~text
Lightroom Classic                     TonePilot (SwiftUI)
    │                                     │
    ├── selected photo IDs ───────────────┤
    │                                     ├── editing intent + limited selection
    │                                     ▼
    │                             Codex CLI (cloud AI)
    │                                     │
    │◄────────── Lightroom MCP ───────────┤
    │  previews / Develop settings        │
    │  proposed edits → applied settings  │
    │                                     │
    └── photographer reviews in Lightroom ◄── session report
~~~

TonePilot's interface does **not** run a local image model. For an edit, it starts **Codex CLI**, which communicates with the user-configured model provider and the Lightroom MCP integration. Lightroom does the RAW rendering and maintains nondestructive adjustments.

## Requirements

- macOS with an Apple Silicon Mac (the prototype was compiled on an M4 Mac mini).
- [Adobe Lightroom Classic](https://www.adobe.com/products/photoshop-lightroom-classic.html) (development machine: 14.5.1).
- [Lightroom Classic MCP](https://github.com/Automaat/lightroom-mcp) plugin/server (development build: v0.24.1).
- Node.js 18+ and npm / npx.
- [Codex CLI](https://github.com/openai/codex), installed and authenticated to a model provider.
- Swift compiler / Apple's Xcode Command Line Tools to build from source.

## Build & use (developer preview)

> The current prototype expects its working directory at **`~/Documents/Lightroom-AI-FirstPass`** and installs **`~/Applications/TonePilot.app`**. This is a development limitation; arbitrary install locations are not supported yet.

1. Clone the repo into its current expected location:

   ~~~bash
   git clone https://github.com/manynames3/TonePilot.git ~/Documents/Lightroom-AI-FirstPass
   ~~~

2. Install the Lightroom bridge following the [upstream installation instructions](https://github.com/Automaat/lightroom-mcp#install-other-ai-tools), restart Lightroom Classic, and in **File → Plug-in Manager → Lightroom MCP** choose **Start Server**. This project does not vendor Adobe Lightroom or the third-party bridge.

3. Register the bridge in Codex if you haven't already:

   ~~~bash
   codex mcp add lightroom -- npx -y @mskalski/lightroom-mcp
   ~~~

4. Build and launch TonePilot:

   ~~~bash
   cd ~/Documents/Lightroom-AI-FirstPass
   chmod +x TonePilot/build.sh
   ./TonePilot/build.sh
   open ~/Applications/TonePilot.app
   ~~~

5. In Lightroom, **back up the catalog** and select no more than 20 expendable/test photos. In TonePilot, click **Sync selection** and verify the count. Choose look/strength/correction types, then use **Run AI First Pass**. **Review all results in Lightroom before making further edits or exports.**

The app keeps text logs/reports in the untracked `runs/` directory. The standalone read-only scanner can be found at `TonePilot/scan-selection.mjs`.

## Safety and privacy

- **Cloud processing:** Codex uses its configured model service; photo previews and relevant metadata **may be transmitted** to that service. Check client consent and the provider's data/privacy terms. This is **not offline-only software**.
- **Nondestructive is not risk-free:** Lightroom catalog state still changes. Back up your catalog and confirm you can revert Develop History changes before testing.
- **Agent-enforced scope:** selected-ID checks, baseline saves, and limited adjustment scope are expressed in the agent's instructions. They are **not yet an independently enforced MCP write allowlist**. Do not assume the UI can enforce every tool call.
- **No automatic export, image upload, photo deletion, or folder reorganization is intended.** The app does not create another photo catalog or permanent preview store.
- **Proof-of-concept security:** locally ad-hoc-signed, not hardened, notarized, audited, or suitable for distribution as a trusted installer.

## Repository layout

~~~text
AGENTS.md                      Codex first-pass editing and safety instructions
README.md                      Project overview and setup
TonePilot/
  build.sh                     Builds ~/Applications/TonePilot.app
  README.md                    Local development notes
  scan-selection.mjs           Read-only Lightroom MCP selection bridge
  Source/
    TonePilotApp.swift         macOS UI + menu-bar entry
    WorkspaceModel.swift       Lightroom checks, selection, Codex workflow
    IconMaker.swift            Local icon generator
runs/                          Local session output, ignored by Git
~~~

## Roadmap

1. Verify Lightroom MCP connection, baseline capture, and actual Develop changes on a small test set.
2. Measure adjustment quality across different lighting scenes, especially skin-tone tint and subject exposure.
3. Add stronger independent tool restrictions, robust cancellation, and reproducible audit/revert checkpoints.
4. Refine the UI into a premium **Darkroom Instrument** companion with **larger, bolder type and accessible controls** (the latest design proposal has not yet been implemented).
5. Add a portable build, signed/notarized installer, more robust scene grouping, and reviewed batch sizes above 20.

## About

**TonePilot** is an independent experiment in making professional Lightroom editing more consistent and less repetitive — while keeping photographers in control of their images and creative choices.

It is **not affiliated with, endorsed by, or an official product of Adobe or OpenAI**. “Adobe,” “Lightroom Classic,” and other product names belong to their respective owners. The [Lightroom MCP project](https://github.com/Automaat/lightroom-mcp) is a third-party dependency maintained separately from TonePilot.

Issues and feature ideas are welcome after the first editing pilot is validated.
