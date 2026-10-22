# Competitive position — checked October 21, 2026

Prices change often; re-check vendor pages before quoting anything publicly.

## What photographers can already buy

| Product | AI editing price (USD) | What it does that TonePilot does not | Source |
|---|---|---|---|
| **Narrative** | Lite $10/mo yearly ($15 monthly) has **no** AI editing. Standard $20 ($29) — unlimited editing with Core and Marketplace AI Presets. Premium $40 ($59) — 1 colour + 1 B&W AI Preset trained on your edits. Ultra $60 ($79) — up to 5 + 5, up to 4 users. Free trial of Ultra. **AI editing is not free.** | Learns a personal style; culling; ships to Lightroom, Photoshop, Capture One | [narrative.so/pricing](https://narrative.so/pricing) (vendor) |
| **Aftershoot** | Edit $30/mo yearly ($35 monthly); Complete (Select + Edit + Retouch) $45 ($55). Unlimited images. 30-day trial. | Personalized AI Profiles from **2,500+** of your edited photos (5,000+ recommended); Instant AI Profiles from presets; masking, crop, straighten; learns from Lightroom Classic history | [aftershoot.com pricing guide, updated Oct 21 2026](https://aftershoot.com/blog/aftershoot-pricing-tiers/) (vendor) |
| **Imagen** | Vendor pricing page refused automated access (HTTP 403). Secondary sources: pay-as-you-go ~$0.05/photo with a ~$7/mo minimum; an unlimited plan ~$129/mo billed yearly. **Unverified.** | Personal AI profiles trained on Lightroom catalogs; returns edits to Lightroom Classic | [filterpixel.com/imagen-ai-pricing](https://filterpixel.com/imagen-ai-pricing) (a competitor — treat with caution) |
| **Lightroom Classic itself** | Included with the subscription | Auto, Match Total Exposures, Sync / Auto Sync, adaptive presets, AI masking of people and subjects | Product knowledge; no price claim made |

## Where TonePilot honestly stands

- **Style.** The competitors learn *your* look from thousands of your edits. TonePilot does not learn a style at all, and should not pretend to.
- **Throughput and cost.** Competitors process whole weddings at flat prices. TonePilot handles 20 photos per pass at ~8 s and ~20,000 model tokens per photo through the Codex CLI.
- **Exposure consistency.** Lightroom's *Match Total Exposures* already equalizes exposure across a selection for free — but from camera settings, not from what happened to the subject's face. TonePilot's scene matching is subject-aware; that difference is untested against real galleries.
- **Trust.** TonePilot's journal, verification of every written value, restore that refuses to overwrite later manual edits, and recovery after a crash are real and tested in simulation. Competitors' recovery behaviour was not evaluated here, so no comparative claim is made.

## Strategic recommendation

Do not compete with personal-style AI editors head-on. The defensible position, if the benchmark supports it, is a **consistency pass that runs after any first edit** — the photographer's preset, Lightroom Auto, or an Aftershoot/Imagen/Narrative profile:

1. TonePilot already works relative to each photo's current settings and never touches profiles, HSL, masks or presets, so it composes with those tools instead of replacing them.
2. Its strongest mechanisms — scene grouping, face-measured exposure matching, white-balance drift sync, preserved intentional looks, cumulative limits and safe undo — target exactly what personal-style AI leaves behind: frames that are each plausible but inconsistent beside their neighbours.
3. That claim is measurable without taste disputes: within-scene face-brightness spread and white-balance spread before and after, plus blind acceptance (G3) on galleries already edited by a competitor.

If G3 shows no consistency or time advantage over "competitor profile + Lightroom Match Total Exposures", the product should not be sold as an editor; the remaining value would be its safety layer, which is not a standalone business.
