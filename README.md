# TonePilot

### A careful, scene-aware first pass for Lightroom Classic.

For portrait, family, wedding and event photographers who already know how to edit and are tired of fixing the same exposure and white-balance drift frame after frame. You select photos in Lightroom; TonePilot groups them into lighting scenes, proposes small corrections that make each scene consistent, and writes only the edits you approve. Lightroom stays your editor.

> [!IMPORTANT]
> **Developer preview · v0.6.0 · not for client work yet.** The engine includes automated safety and recovery tests against a simulated Lightroom, including killed processes and a dying bridge. The current test inventory and real-world checks are recorded in the evidence log. In real Lightroom, TonePilot has made 16 Develop writes (13 RAW, 3 HEIC), all verified by read-back, including white-balance corrections on RAW, and has compared AI services and models read-only on real photos. **Restore on real photos, the test-catalog protocol and a photographic-quality benchmark have not been run yet.** Time savings are unmeasured. See the [changelog](CHANGELOG.md) and [what has actually been measured](docs/EVIDENCE.md).

<table>
<tr>
<td width="50%" valign="top"><img src="docs/screenshots/review-plan.png" alt="TonePilot review screen: a plan grouped by lighting scene, each photo with original and proposed values, a reason, and an approval checkbox." width="440"></td>
<td width="50%" valign="top"><img src="docs/screenshots/recovery-interrupted.png" alt="TonePilot recovery screen after an interruption: a red callout explains a write was in flight, and the primary action is Check Lightroom now." width="440"></td>
</tr>
<tr><td align="center"><sub><b>Review</b> · every value, reason and approval in one place</sub></td><td align="center"><sub><b>Recovery</b> · an interrupted write is never guessed</sub></td></tr>
</table>

<sub>Screens use synthetic demo data from the test harness, not real photographs.</sub>

## Recent engineering work

- **Scene-aware exposure and white balance.** The latest rules refine exposure sharing between comparable frames, combine measured and model-based colour evidence, and flag disagreement for review. Exposure and white balance are the default correction scope.
- **A consistent AI interface.** Provider selection, pinned model settings and recorded assessments support repeatable comparisons. Credentials stay separate from the Lightroom bridge.
- **Quality checks with controls.** Read-only comparisons can use the photographer's finished edits. An automated judge uses approximate renders, identical-image controls and deliberately wrong edits; its current noise does not establish editing quality or superiority.

See the [measured results and limits](docs/EVIDENCE.md#new-judgment-rules-on-real-photos-october-24-2026-read-only). Recovery captures use synthetic sessions; restoration on real photos remains unverified.

## What it does

1. **Reads your Lightroom selection** (up to 20 photos in this version) and saves every photo's original settings before anything else.
2. **Measures each Lightroom preview on your Mac** — faces and skin, highlight headroom, capture time, flash — and **groups photos into lighting scenes**.
3. **Asks the AI service you chose for a judgment** of light, intent, skin cast and subject exposure, in a strict typed format. The model has no Lightroom access.
4. **Builds a consistent plan per scene**: darker frames are matched to their neighbours by measured face brightness; auto white-balance drift is synced within the same light; deliberate low-key, silhouette and high-key frames are left alone; brightening stops before it clips highlight detail.
5. **You review and approve** each photo — original, proposed and (later) verified values, the reason, and what TonePilot could not judge.
6. **Applies only what you approved**, one photo at a time, re-checking each photo first and reading every value back afterwards.
7. **Restores originals on request** — but never over an edit you made afterwards.

### Editing direction is enforced, not suggested

| | Subtle | Balanced | Stronger |
|---|---|---|---|
| Max exposure change (cumulative across runs) | ±0.35 EV | ±0.6 EV | ±1.0 EV |
| Max white-balance change | ±12 mired (≈ ±350 K daylight) | ±20 mired | ±30 mired |
| Share of each computed correction applied | 60% | 80% | 100% |
| Model confidence needed (uncalibrated, same at every strength) | 82%, or 70% when the on-device measurements independently confirm the correction | same | same |

**Natural** targets neutral, consistent subjects. **Soft & airy** targets +0.2 EV brighter subjects with lifted shadows and blacks. **True to scene** ignores small corrections and preserves deliberate coloured light. Looks only use controls TonePilot can write: exposure, highlights, shadows, whites, blacks, and (RAW only) temperature and tint.

## Safety you can check

- Analysis never writes. Applying and restoring need explicit confirmation.
- A crash-safe journal records every intended write *before* it happens. After a crash, force-quit or Lightroom closing, TonePilot reopens the affected session and settles it from Lightroom's actual values — it never assumes.
- Photos you edit after analysis are skipped. Restore only reverses TonePilot's own values while they're untouched; your later edits always win.
- Running TonePilot again can't push a photo past one pass's limits.
- Never touched: crop, masks, profiles, HSL, presets, metadata, ratings, export.
- On JPEG, HEIC and TIFF files white balance needs a bridge that can write Lightroom's relative white balance; without one TonePilot says so instead of guessing.
- API keys live only in the macOS Keychain and never reach the Lightroom bridge or any other helper process.

## Choose your AI service

| In Setup | What it is | Cost | Measured so far |
|---|---|---|---|
| **ChatGPT subscription** (default) | GPT-6.1-Sol through your signed-in Codex CLI | Uses your ChatGPT plan | 10 real photos × 2 runs: same decision both times on 10/10; ~12,400 tokens and ~9 s per photo |
| **OpenAI Decisions** | GPT-6-Luna returning typed answers with a probability for every option | Your OpenAI API key, roughly $0.0003 a photo (estimate) | Built and tested against a fake API only |
| **Amazon Bedrock** | Claude in your AWS account: Opus/Sonnet/Haiku 5.5, or Sonnet 4.6 / Haiku 4.5 / Opus 4.6 | Your AWS bill | Sonnet 4.6, Haiku 4.5 and Opus 4.6 run on one real photo |
| **Anthropic API** | Claude with your API key | Pay per photo | Fake API only |

[`Benchmarks/compare-providers.mjs`](TonePilot/Benchmarks/README.md) runs any of them side by side on your own selection, read-only, and reports agreement, repeatability, tokens, time and cost. A [TonePilot Cloud backend](TonePilot/Cloud/README.md) (AWS, not deployed) lets licensed users run Claude on the owner's Bedrock account without holding any AWS credentials.

## Your photos and privacy

TonePilot sends Lightroom previews (at most 1,024 pixels) and the photo's current Develop values to the AI service **you** choose in Setup. Nothing else leaves your Mac: face, skin and highlight measurements run locally, and your own Codex plugins, apps and skills are kept out of TonePilot's calls. Make sure you have your clients' consent and accept your AI provider's terms before using client work.

## Try the developer preview

Test photos in a **backed-up, disposable catalog** only. Requirements: macOS 14+, Apple Silicon, Lightroom Classic, the [Lightroom MCP plug-in](https://github.com/Automaat/lightroom-mcp) 0.24.1, and one AI service from the table above. Building needs the Xcode Command Line Tools and Node.js 18+; the app itself ships its own Node.js runtime. TonePilot's own Lightroom plug-in, which will replace the third-party one, is included but not yet verified inside Lightroom.

```bash
git clone https://github.com/manynames3/TonePilot.git
cd TonePilot
./TonePilot/build.sh
open ~/Applications/TonePilot.app
```

TonePilot's **Setup** screen checks all of the above and tells you how to fix anything missing. The build is ad-hoc signed and not notarized.

## Status

| Area | State |
|---|---|
| Durable sessions, recovery, verified writes, safe restore | Implemented; tested against a simulated Lightroom with fault injection |
| Real Lightroom read path, measurements, scene grouping, planning | Verified read-only on HEIC and RAW photos |
| Real Develop writes | 16 in the owner's catalog, 16/16 verified; restore not yet exercised; test-catalog protocol ([gate G1](docs/VALIDATION.md)) not run |
| White balance | Skin-tone verdict + measured colour-cast correction; verified writes on RAW, which also switch Lightroom to Custom; HEIC/JPEG need a bridge that writes relative white balance |
| AI services | Four behind one interface; Codex models compared on 10 real photos (GPT-6.1-Sol most consistent); Decisions API and Claude 5.5 not yet run for real |
| TonePilot's own Lightroom plug-in | Built and tested against a mock; **not yet verified inside Lightroom** |
| Multi-scene galleries | **Not yet run** |
| Photographic quality, time saved | **Unmeasured** — blind benchmark harness ready ([gate G3](docs/VALIDATION.md)) |
| Galleries over 20 photos | Not supported until scale gates pass |
| Model consistency | GPT-6.1-Sol: same decision twice on 10/10 real photos; GPT-6-Luna 70–90% ([evidence](docs/EVIDENCE.md)) |
| Signed and notarized installer | Scripts ready; not done |

## Documentation

- [Audit of v0.4 and what changed](docs/AUDIT.md)
- [Evidence — real vs simulated vs unmeasured](docs/EVIDENCE.md)
- [Validation gates and protocols](docs/VALIDATION.md)
- [Competitive position and strategy](docs/COMPETITIVE.md)
- [Engine architecture and safety invariants](TonePilot/Engine/README.md)
- [Source, build and tests](TonePilot/README.md)

Not affiliated with or endorsed by Adobe, OpenAI, Anthropic, Amazon or the Lightroom MCP project. Adobe Lightroom Classic is a trademark of Adobe. **License:** none assigned yet; public visibility does not grant permission to redistribute this code.
