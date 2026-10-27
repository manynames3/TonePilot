# Changelog

Every claim here is backed by [docs/EVIDENCE.md](docs/EVIDENCE.md), which keeps real, simulated and unmeasured results apart.

## Unreleased

- **Tint-bias sanity checks (synthetic only).** The analyzer now checks neutral JPEGs tagged sRGB, Display P3 and Adobe RGB, plus green and magenta controls; planning tests check neutral whites and corrections in both tint directions. No fixed tint offset was found in these controls. This does not establish whether the greenward corrections on the owner's photos are right; correction rules and confidence thresholds are unchanged.

## 0.6.1 — developer preview (October 27, 2026)

- **The after-edit check retries Lightroom's intermittent "error loading thumb"** (three tries, with a pause and another size) and, if it still can't get a preview, says so in plain words — the edit itself had already been verified from Lightroom's values; only the optional brightness check is skipped.
- **Far fewer photos held back for review, without lowering the bar blindly.** An evidence ladder replaces the single confidence threshold: at 82% everything goes ahead; between 70% and 82% only the corrections the on-device measurements independently confirm go ahead (a face measurably very dark when the model says "under", white surfaces agreeing with the model's skin cast); below 70% nothing is changed. On 20 real RAW photos held-back photos fell from 6 to 1. Below the bar only the axes the measurement confirmed are applied, a photo below the bar never leads its scene, and photos with deliberate or weak-cast evidence are left alone rather than synced; JPEG/HEIC photos keep their own skin correction too.
- **Skin is the reference.** A cooler or mixed background no longer switches white balance off or lowers the model's confidence; "mixed light" is no longer a verdict the model can retreat to, and each photo's own skin correction wins over scene alignment.
- **Fixed a bug that blocked correct photos.** Rounding a limited Temperature change to a whole Kelvin could land just past the strength limit at low colour temperatures (2900 K → 3079 K is 20.05 mired against 20), and the whole photo was rejected.

Judgment changes from an independent review (ChatGPT, then a code review), all test-first:

- **Exposure + white balance by default.** Tone sliders are opt-in, so the model's tone proposals never reach writes unless asked for.
- **One confidence bar at every strength** (82%, provisional until calibrated). Stronger used to admit photos the model was less sure about.
- **White balance evidence is weighed, not maximised.** Agreeing AI and measurement amounts are averaged (the larger used to win); opposite directions keep the AI's skin judgment and flag the photo; a measured component too small to act on can't agree or disagree. When the AI calls skin natural, a cast on real white surfaces is corrected half-way with a "check this photo" note and never spreads to the rest of the scene; a cast seen only on general neutral areas is advisory.
- **Different people keep their own brightness.** Frames at the same effective exposure (camera settings plus the photo's Lightroom exposure) in the same light share the scene's judgment instead of being pulled to one face; exposure drift and flash frames are still matched by face.
- **Benchmark integrity.** "Validated" now needs every skin group (≥ 30 photos) to clear a 75% acceptance lower bound; duplicate or incomplete evidence is rejected; the regression gate needs ≥ 189 zero-regression photos (documented). New `owner-review.mjs` for better/same/worse owner ratings, labelled "owner pilot — not validated".
- **G1 sandbox cycle can't pass by accident.** It requires real exposure and white-balance writes, Custom mode after apply and the original mode after restore, a scripted photographer edit that restore must refuse, crash recovery, the tested bridge version, and a folder named TonePilot-Sandbox (symlinks resolved).
- **Codex usage limits** are reported in plain words with the reset time.

## 0.6.0 — developer preview (October 23, 2026)

- **Choose your AI service in Setup.** ChatGPT subscription (Codex CLI, default), Claude on Amazon Bedrock (region, optional AWS profile, optional Bedrock API key) or Claude through the Anthropic API, with Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5. API keys live only in the macOS Keychain. Setup checks only the chosen service and, for Claude, makes one tiny live call; the app bundles the pinned Claude SDKs. Tested against a local fake of the API only: no real Bedrock or Anthropic call has been made yet.
- **TonePilot Cloud backend (not deployed; simulated only).** `TonePilot/Cloud`: an AWS SAM stack (HTTP API, one Lambda, DynamoDB usage table, SSM-held license secret, 30-day logs, monthly budget alert) through which a licensed app uses Claude on Amazon Bedrock with the owner's IAM role, so no AWS credentials ship in the app. The server picks the model and the assessment schema, caps photos per license per day atomically, and logs no prompts, images or answers. Engine provider `cloud` (`TONEPILOT_CLOUD_URL`, `TONEPILOT_LICENSE`).
- **`Benchmarks/compare-providers.mjs`.** Analyzes the same photos with each provider and model (read-only) and reports agreement with the current one, run-to-run repeatability, tokens, seconds and — with prices you supply — USD per photo.
- **AI and AWS credentials never reach the third-party Lightroom bridge** (it used to inherit the engine's whole environment).
- **Node.js is bundled.** The build ships the official Node.js 22.23.4 runtime (checksum-verified, signed with the app); TonePilot no longer needs Node installed, and the engine, bridge and Codex CLI all run on it.
- **Scene-batched AI assessment (opt-in, `TONEPILOT_AI_BATCH=2…6`).** Up to six photos of one lighting scene share one Codex call, with a per-photo fallback when the answer can't be matched to its photos. Measured on a real preview: about 72% fewer input tokens and 58% less model time per photo. It stays off by default because frames that differ in one call were judged against each other (6/12 decisions within tolerance of per-photo calls).
- **TonePilot's own Lightroom plug-in** (`TonePilot/LightroomPlugin`, not yet verified inside Lightroom). A localhost-only, token-protected socket with eight actions and one Develop write action limited to TonePilot's ten keys, recorded in History as "TonePilot first pass". It reports every scalar Develop value, so staleness and read-back checks also see crop, profile, lens and other changes the MCP bridge cannot. The engine uses it when it is running and otherwise falls back to the Lightroom MCP bridge unchanged.
- **Lightroom snapshot before the first write** to each photo ("TonePilot before …"), best effort and journaled, with TonePilot's plug-in.
- **`select` engine mode** for a future "Show in Lightroom" button.
- **Previews capped at 1024 px.** Lightroom sometimes answers a failed preview request with the full-size image (a 5472 × 3648 CR3 was sent to the model); previews are now scaled down locally before measurement and assessment, never up.

## 0.5.0 — developer preview (October 22, 2026)

The 0.4 audit ([docs/AUDIT.md](docs/AUDIT.md)) found that recovery could fail silently, repeated runs could compound edits, and editing decisions were single-photo AI guesses. 0.5 rebuilds the engine, the editing logic and the app.

### Safety and recovery
- **Crash-safe session journal.** Every session is an append-only, fsync'd record. Status ("Applied", "Restored", "Interrupted") is worked out from each photo's state every time, never stored, so TonePilot can no longer report "restored" while an edit remains (v0.4 could).
- **Write intent before every write; results only from read-back.** If TonePilot, the app or the Lightroom bridge dies mid-write, the session reopens as *Interrupted* and is settled from Lightroom's actual values, never guessed.
- **Your edits always win.** Photos edited in Lightroom after analysis are skipped. Restore only reverses TonePilot's own values, only while they're untouched, and puts the original white-balance mode back.
- **No compounding.** Limits are cumulative from each photo's original values across all sessions.
- **One writer at a time.** The engine is locked against a second copy and stops after the current photo if the app quits.
- **Pinned, bundled Lightroom bridge.** Replaces an unpinned `npx -y` download that gave whatever npm served write access to the catalog.
- **Selection check without O(n²) reads.** Apply re-reads the full Lightroom selection every 25 photos instead of before every photo: 10,980 instead of 250,500 metadata rows at 500 photos.
- **Robust previews.** Lightroom's intermittent "error loading thumb" is retried; a photo that still has no preview is flagged instead of failing the whole run.

### Photographic engine
- **On-device measurements** of every Lightroom preview: faces and skin colour (CIELAB), highlight headroom, a strict white reference (white clothing, trim, sky), EXIF from the original file.
- **Lighting scenes.** Photos are grouped by time, camera body, flash, light level, as-shot white balance and surroundings. Exposure is matched across a scene from measured face brightness; auto-white-balance drift is synced within the same light.
- **Skin-tone white balance.** The AI must give a verdict on every photo: natural, too warm, cool, green or magenta, mixed light, or no skin. It also states the temperature and tint shift needed.
- **Colour-science cast correction.** Casts measured on white surfaces are converted to Temperature/Tint moves using the Planckian locus and Adobe's DNG tint scale, with both sliders solved together. The AI decides direction; when the measurement agrees, the measurement decides the amount. A visible cast is corrected even if the AI calls skin natural. Deliberate warm light, creative colour and mixed light are left alone.
- **White balance on JPEG, HEIC and TIFF** via Lightroom's relative `IncrementalTemperature`/`IncrementalTint`. This needs the TonePilot edition of the bridge: `TonePilot/BridgePatch/patch-bridge.mjs` adds exactly those two keys, is version-checked and keeps backups.
- **Looks and strengths are enforced numbers.** Caps are in mired for white balance; each strength sets how much of a correction is applied and a confidence threshold. Deliberate low-key, high-key and silhouette frames are preserved in every look. Explanations name the look when it, not a correction, moves exposure.
- **Corrections you choose.** For example exposure and white balance only, with highlights and shadows off.

### App
- **Native review and recovery.** Photos are grouped by scene with original → proposed → verified → restored values, a skin-tone line on every photo, per-photo approval, and one-click restore. Interrupted and partly restored sessions explain what to do.
- **Editorial design kept:** warm paper, serif headings, terracotta actions; the charcoal rail now carries navigation, sessions and connection status. The app always uses this palette rather than following system Dark Mode.
- **Setup checklist** with a live Lightroom handshake and concrete fixes, including "White balance on JPEG, HEIC and TIFF".
- v0.4 sessions are listed read-only under *Earlier versions*.

### Tooling
- **78 automated tests** against a simulated Lightroom with fault injection: killed engines, bridge exits, late and lost writes, damaged journals, manual edits, selection swaps, preview failures. Reintroducing the main v0.4 defects makes the intended tests fail. CI runs them on macOS for every pull request.
- **Benchmarks:**
  - blind evaluation with confidence intervals, a paired test against each baseline, per-skin-group results and confidence calibration (`evaluate.mjs`);
  - test–retest repeatability (`repeatability.mjs`);
  - engine scaling (`scale.mjs`).
- **Gated real-write protocol** for a disposable catalog (`tests/live/sandbox-cycle.mjs`). Build and notarization scripts are ready for Developer ID signing.

### Real-world results so far
- 15 real Develop writes in the owner's catalog (12 RAW, 3 HEIC): **15/15 verified by read-back**. 6 of them were white-balance changes on RAW.
- On a photo whose white shirts measure magenta and cool (a* +2.6, b* −1.1), the plan now moves Tint 14 → 8 (Balanced) instead of no change.

### Still not done
- Restore has not been exercised on real photos, and the gated test-catalog protocol (G1) has not run.
- No blind quality benchmark; time savings unmeasured; AI confidence uncalibrated.
- The 20-photo limit stays until the scale gates pass.
- Not Developer ID signed or notarized.
- Relative (HEIC/JPEG) white-balance scale is provisional until calibrated on real files.
- Next: TonePilot's own Lightroom plug-in to replace the third-party bridge.
