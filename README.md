# TonePilot

### You shouldn't have to fix the same photo problem 200 times.

**An AI-assisted first-pass companion for portrait, family, wedding, and event photographers who work in Adobe Lightroom Classic.**

Your clients want beautiful skin tones, consistent color, and photographs that feel like they belong together. You want to spend your time creating that experience—not correcting the same exposure and white-balance problems, frame after frame.

**TonePilot is being built to take the repetitive first pass off your plate. You keep the creative decisions, and you keep working in Lightroom.**

> [!IMPORTANT]
> **Early prototype · v0.4 · Not production-ready.** The native Mac app builds and launches, and a real read-only five-photo AI analysis produced four proposed edits and one skip. A guarded read/write/restore cycle passes simulated Lightroom tests. **Actual real-photo Develop writes, editing quality, and catalog restoration have not yet been verified.** Use a backed-up disposable test catalog only. Time savings have not been benchmarked.

## A closer look

These are **real screenshots of TonePilot's v0.3 Editorial Studio macOS interface**, not AI-generated mockups. The layout combines a warm, light control surface with a charcoal editorial side panel, larger typography, custom editing looks, and restrained controls. The three landscape cards are decorative vector illustrations—not photographs or processed-image previews. The screenshot was captured before selection verification. A later read-only connection test retrieved five selected HEIC photos; live AI Develop edits remain untested.

<table>
<tr>
<td width="50%" valign="top"><img src="docs/screenshots/tonepilot-edit.png" alt="TonePilot Editorial Studio's light-and-charcoal macOS app with Lightroom selection controls, illustrated editing looks, correction strength and first-pass adjustment toggles." width="530"></td>
<td width="50%" valign="top"><img src="docs/screenshots/tonepilot-getting-started.png" alt="TonePilot Editorial Studio's Getting Started sheet with four steps and bridge troubleshooting." width="530"></td>
</tr>
<tr><td align="center"><sub><b>Edit</b> · Choose what AI should correct</sub></td><td align="center"><sub><b>Getting started</b> · Stay in Lightroom</sub></td></tr>
</table>

## Who is TonePilot for?

Photographers who **already know how to edit**—and would rather spend less time doing corrections a hundred times.

- **Portrait and family photographers** who want natural, consistent skin tones across changing light.
- **Wedding and event photographers** moving between window light, flash, shade, tungsten, and golden hour.
- **High-volume Lightroom Classic editors** who want a more consistent starting point without handing over their style.

If you love Lightroom but find yourself repeatedly adjusting **Temperature, Tint, Exposure, Highlights, and Shadows** across a gallery, this project is for you.

## The problem we're solving

Presets are useful. But a preset can't always tell the difference between intentional golden-hour warmth, a green cast on someone's skin, and a backlit subject who needs a little more light.

A photograph can look good on its own and still feel noticeably different beside the next frame. Bringing a gallery together takes judgment—and a lot of repetitive work.

**The value proposition:** an AI-assisted starting point that reduces tedious corrections **while leaving the artistic finish and final approval to the photographer.** That's the product goal, not a proven result of v0.4.

## How TonePilot v0.4 works

1. **Select your photos in Lightroom Classic.** Stay in your catalog, with 1–20 pilot photos selected.
2. **Choose your editing direction.** Set Natural, Soft & Airy, or Scene Mood; correction strength; white balance, exposure and/or tone.
3. **Analyze First Pass (read-only).** The guarded engine captures source identity, available Develop settings, and Lightroom-rendered previews before cloud AI evaluates the photographs. Uncertain recommendations are flagged.
4. **Review the proposed settings.** A private session report shows proposed changes and confidence. No Lightroom Develop write happens during analysis.
5. **Explicitly Apply Reviewed Plan.** TonePilot checks the exact selected IDs, source file identity, current Develop values and approved edit limits. Only a restricted eight-key set can be written. The engine independently verifies the values and checks unrelated settings for changes.
6. **Review inside Lightroom.** Inspect photos in Lightroom Classic. A conditional restoration command can restore verified TonePilot changes if Lightroom's values have not been altered afterward.

**Lightroom is the editor. TonePilot is the assistant.** No second catalog, image browser or automatic export. Review and recovery are still experimental; do not use valuable images for this pilot.

## What's available today?

| Capability | Verified status |
| --- | --- |
| Native SwiftUI Editorial Studio and menu-bar utility | **Built and launched** on Apple Silicon |
| Portable editing engine bundled in the app; private session storage | **Implemented** in v0.4 |
| Read-only Lightroom selection + metadata + previews | **Verified on five HEIC photos** |
| AI evaluation of those Lightroom previews | **Verified**: 4 proposed edits, 1 skipped, 0 applied; no evidence yet that corrections are superior |
| Explicit review-before-apply gate | **Implemented** in SwiftUI |
| Setting and photo allowlists, stale-selection and catalog-source checks | **Implemented**, passing simulated bridge tests |
| Baseline journal, read-back checks, conditional restoration | **Implemented**, verified with a mocked Lightroom server; real catalog recovery untested |
| Independent preview luminance/clipping measurements | **Implemented**, histogram smoke-tested; not skin-tone QA |
| 20-photo pilot limit | **Enforced** in the engine and app |
| Accurate results or 40% editing time saved | **Not established**; blind benchmark harness added but has no real scores |
| Reliable 500-photo edits | **Not supported** |
| Signed/notarized public installer | **Not yet** (local ad-hoc signature only) |

**Important:** The previous five-photo edit attempt made zero writes due to a Codex MCP permission error. The new v0.4 agent no longer has a direct Lightroom write path: it only produces data proposals. TonePilot's guarded engine applies prevalidated changes after explicit user confirmation, then reads back Lightroom values. These real write operations still require validation on disposable test photos.

## Under the hood

TonePilot currently uses cloud AI via your existing Codex CLI, **not** a specialized trained model or an offline local LLM.

~~~text
Lightroom Classic → TonePilot selection/metadata/preview bridge
                               |
                   Read-only AI image analysis
                      (Codex CLI, cloud)
                               |
                      Saved edit plan
                               |
               Photographer review + confirmation
                               |
              Typed validator / ID & catalog checks
                               |
                  Guarded Develop writes
                               |
              Lightroom value read-back / preview QA
                               |
           Reports + conditional session restoration
~~~

Unlike the v0.3 prototype, Codex does **not** receive direct Lightroom write tools for the image-analysis step. Only the guarded Node engine may call set_develop_settings. A local Swift histogram utility measures cached JPEG luminance and clipping, but cannot certify skin-tone correctness. Unsupported controls, notably numeric Temp/Tint on certain HEIC files, are skipped.

This still depends on the third-party [Lightroom Classic MCP bridge](https://github.com/Automaat/lightroom-mcp). It is not an Adobe-official integration. See [engine details](TonePilot/Engine/README.md) and the [blind benchmark protocol](TonePilot/Benchmarks/README.md).

### Lightweight by design

TonePilot doesn't build a second photo library or constantly render previews in its own window. Lightroom handles photographic rendering. AI analysis is performed when editing is requested.

There will still be resource costs when Codex is active and Lightroom generates previews. Any memory, speed, or time-savings claims need real benchmarks.

## Build and try the development prototype

This is for photographers comfortable installing development software and **test photos only**.

Requirements: macOS 14+, Lightroom Classic, Node.js 18+, npx, authenticated Codex CLI, and Xcode Command Line Tools for a source build. Tested on an M4 Mac mini.

~~~bash
git clone https://github.com/manynames3/TonePilot.git
cd TonePilot
./TonePilot/build.sh
open ~/Applications/TonePilot.app
~~~

Install and start the [Lightroom MCP plug-in](https://github.com/Automaat/lightroom-mcp) following its upstream directions. The native app bundles the guarded engine and scanner; it no longer needs to be installed into any specific source directory. Local session plans and audit reports are stored under your user's Library/Application Support/TonePilot/runs directory.

1. Back up the catalog and select a few expendable test photos.
2. Read selection in TonePilot and confirm the count.
3. Choose correction preferences, then **Analyze First Pass**. This step never writes Develop settings.
4. Open the report, verify which changes were proposed, and only then optionally confirm **Apply Reviewed Plan**.
5. Review all results inside Lightroom. Conditional restoration is available for verified session edits; it refuses to overwrite later manual adjustments.

Run the local tests with the Node test runner on TonePilot/tests/*.test.mjs. A local, unnotarized developer-preview disk image may be generated in dist/; it is not an official release installer. The current tests exercise a simulated Lightroom server, not a real editing quality benchmark.

## Latest v0.3.1: stalled-session fix

A pilot on October 21 exposed a reliability issue. Five photos were selected, but Codex had an MCP approval policy of 'never'. The first get_selected_photos request was rejected because it required approval. **No edits were applied.** The report was saved, yet the UI could continue displaying an editing state after Codex had already exited.

The v0.3.1 changes:

- **Codex MCP permission handling:** use Codex CLI's '--approve-for-me' automatic reviewer instead of rejecting all MCP requests. Codex still runs with its 'workspace-write' sandbox; TonePilot does **not** use a no-sandbox bypass. Automatic approval review is not manual approval per tool call.
- **Reliable completion:** finish on Codex process termination rather than waiting for inherited child-process stdout pipes to close.
- **Truthful outcomes:** reports describing blocked tool access or incomplete edits are surfaced as failures, even when the agent exits with status 0.
- **Read-only validation:** a controlled Codex MCP call retrieved the five selected photos without writing Lightroom adjustments.

**Still untested:** a complete successful Lightroom Develop-write pilot on a real test photograph. The v0.4 guarded engine replaces the former direct agent workflow.

### If a session appears stuck

Open **Reports** in TonePilot and inspect the latest session. If the report mentions 'MCP tool call requires approval, but approval policy is never', Lightroom editing was blocked. In the October 21 incident, TonePilot edited **zero** photos.

Update to the current build, relaunch TonePilot, verify the selection again, and use test photographs with a current catalog backup. For any interrupted session, inspect Lightroom's Develop History before retrying: a partial run may have applied earlier adjustments even if the final report failed.

## Your photos, your control

- **Not offline-only.** Codex may send rendered image previews and relevant metadata to its configured AI service. Confirm you have the necessary consent and review the provider's privacy terms before using client photographs.
- **Back up first.** Lightroom changes are nondestructive but still change catalog editing state.
- **The v0.4 guarded engine enforces selected IDs, source file identity, allowed Develop keys, conservative deltas and read-back checks.** AI proposals cannot bypass those restrictions through the app. This is not a full Lightroom sandbox: another external process or third-party plug-in could still alter the catalog, and catalog-wide rollback is not yet tested.
- **No automatic exporting or publication.** The intended workflow leaves final review and delivery in Lightroom.
- **No production quality guarantee.** This is a research-and-development prototype until actual edit quality and reliability are measured.

## What comes next?

1. **Prove actual writes:** use a disposable Lightroom test catalog to validate first-pass Develop writes, captured baselines, verified re-rendering and restoration.
2. **Prove photographic quality:** blind-score held-out galleries versus Lightroom Auto and established editors using the benchmark harness.
3. **Validate safety in Lightroom itself:** simulated guards pass, but partial-write and crash recovery need real catalog tests.
4. **Scale and refine workflow:** real scene grouping, batch checkpointing, Lightroom-native exception navigation and accessibility.
5. **Make it distributable:** bundle the remaining third-party dependencies, guided plug-in setup, installer, trusted signing and notarization.

## About the project

**TonePilot exists for photographers who want their time back without giving up their eye.** It is an independent experiment in turning routine photo corrections into a reliable AI-assisted first pass—inside the Lightroom workflow professionals already trust.

Not affiliated with or endorsed by Adobe or OpenAI. Adobe Lightroom Classic and other names are trademarks of their respective owners.

**License:** no redistribution license has been assigned yet. Public visibility does not by itself grant permission to redistribute or republish this code.
