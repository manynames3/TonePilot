// Editing direction and strength as enforced numbers, not prompt wording.
//
// Strength decides how far TonePilot may move a photo from its pre-TonePilot origin
// (cumulative across sessions) and how much of a computed correction is applied. How sure
// the evidence must be is a separate, single threshold: a larger strength must never admit
// photos the model is less sure about. It is provisional until calibrated on rated photos.
export const MIN_CONFIDENCE = 0.82;
// Between the floor and the bar a photo still goes ahead, but only for corrections the
// on-device measurements independently confirm (see harmonize.mjs). Below the floor
// nothing is changed. Both are provisional until calibrated on rated photos.
export const CORROBORATED_CONFIDENCE = 0.70;
//
// Temperature limits are in mired (1e6 / Kelvin) because perceived white-balance shifts
// are roughly uniform in mired: 600 K is a huge move at 3200 K and a small one at 6500 K.

export const STRENGTHS = Object.freeze({
  Subtle: Object.freeze({
    fraction: 0.6,
    caps: Object.freeze({Exposure2012: 0.35, TemperatureMired: 12, IncrementalTemperature: 6, Tint: 6,
      Highlights2012: 12, Shadows2012: 12, Whites2012: 10, Blacks2012: 10})
  }),
  Balanced: Object.freeze({
    fraction: 0.8,
    caps: Object.freeze({Exposure2012: 0.6, TemperatureMired: 20, IncrementalTemperature: 10, Tint: 10,
      Highlights2012: 20, Shadows2012: 20, Whites2012: 15, Blacks2012: 15})
  }),
  Stronger: Object.freeze({
    fraction: 1.0,
    caps: Object.freeze({Exposure2012: 1.0, TemperatureMired: 30, IncrementalTemperature: 15, Tint: 15,
      Highlights2012: 30, Shadows2012: 30, Whites2012: 25, Blacks2012: 25})
  })
});

// Absolute ceiling, independent of any preference or model output.
// Relative (JPEG/HEIC) temperature uses Lightroom's ±100 scale; its caps are provisional
// until calibrated against Kelvin-equivalent shifts on real files.
export const HARD_CAPS = Object.freeze({Exposure2012: 1.0, TemperatureMired: 35, IncrementalTemperature: 15, Tint: 15,
  Highlights2012: 30, Shadows2012: 30, Whites2012: 25, Blacks2012: 25});

// Looks only use controls TonePilot can actually write: exposure, the four tone
// sliders and (RAW only) Temperature/Tint. Anything they cannot produce is not offered.
export const LOOKS = Object.freeze({
  'Natural': Object.freeze({
    label: 'Natural',
    summary: 'Neutral skin, consistent subject exposure, highlights protected.',
    exposureBiasEV: 0, exposureDeadbandEV: 0.08,
    toneBias: Object.freeze({Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0}),
    maxNewClipFraction: 0.004, respectCreativeColour: false
  }),
  'Soft & airy': Object.freeze({
    label: 'Soft & airy',
    summary: 'Brighter subjects (+0.2 EV target), lifted shadows and blacks, softened highlights.',
    exposureBiasEV: 0.2, exposureDeadbandEV: 0.08,
    toneBias: Object.freeze({Highlights2012: -8, Shadows2012: 10, Whites2012: 0, Blacks2012: 8}),
    maxNewClipFraction: 0.008, respectCreativeColour: false
  }),
  'True to scene': Object.freeze({
    label: 'True to scene',
    summary: 'Keeps the light and mood: smaller corrections are ignored and deliberate colour is preserved.',
    exposureBiasEV: 0, exposureDeadbandEV: 0.2,
    toneBias: Object.freeze({Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0}),
    maxNewClipFraction: 0.003, respectCreativeColour: true
  })
});

export function resolvePolicy(look, strength) {
  const l = LOOKS[look], s = STRENGTHS[strength];
  if (!l || !s) throw new Error('Unknown editing direction or strength');
  const caps = {};
  for (const [k, v] of Object.entries(s.caps)) caps[k] = Math.min(v, HARD_CAPS[k]);
  return {look, strength, fraction: s.fraction, minConfidence: MIN_CONFIDENCE, corroboratedConfidence: CORROBORATED_CONFIDENCE, caps,
    exposureBiasEV: l.exposureBiasEV, exposureDeadbandEV: l.exposureDeadbandEV,
    toneBias: {...l.toneBias}, maxNewClipFraction: l.maxNewClipFraction, respectCreativeColour: l.respectCreativeColour};
}

export const mired = kelvin => 1e6 / kelvin;
export const kelvin = m => 1e6 / m;
