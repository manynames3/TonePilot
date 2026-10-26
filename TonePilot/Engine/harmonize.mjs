// Turns per-photo evidence into scene-consistent, policy-bounded slider values.
//
// The model's per-photo judgments are noisy; local measurements are precise but have no
// taste. So: the model decides WHETHER and roughly HOW MUCH a frame needs correcting and
// what the photographer intended; the scene aggregates those judgments (median) into one
// target; measured face brightness converts the target into a per-frame exposure; and
// every number is clamped by the strength policy relative to the photo's origin.
//
// Skin tones are never pushed toward a universal brightness or colour: exposure targets
// come from the model's view of THIS scene, and only frame-to-frame consistency of the
// same light is enforced.
import {mired, kelvin} from './policy.mjs';
import {sceneFeatures} from './scenes.mjs';
import {validateSettings, roundSetting} from './guard.mjs';
import {measuredCast, correctionForCast, relativeCorrectionForCast, describeCast} from './colour.mjs';

const TONE_KEYS = ['Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012'];
const KEEP_INTENT = new Set(['low-key', 'high-key', 'silhouette']);
export const LIMITS = Object.freeze({
  sceneDisagreementEV: 1.0, sameCameraExposureEV: 1 / 3, veryDarkFace: 0.05, wbDeadbandMired: 3, wbOutlierMired: 15, wbDriftMired: 8,
  tintDeadband: 2, toneDeadband: 3, skinHueWarnDeg: 10, minFaceLuma: 0.002, relativeWbAgreement: 8,
  // A face must be big enough in a big enough preview to be measured reliably. Real
  // Lightroom previews can come back smaller than requested (416 px was observed).
  minFaceArea: 0.004, minPreviewEdge: 500
});

export function median(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const signed = (x, digits = 2) => (x > 0 ? '+' : '') + x.toFixed(digits);

// Fraction of pixels newly clipped if exposure rises by ev, from the analyzer's
// cumulative curve (sampled every 0.05 EV up to 1 EV). Null when unmeasured.
export function newClipFraction(metrics, ev) {
  const curve = metrics?.clipAtEV;
  if (!Array.isArray(curve) || !curve.length || ev <= 0) return ev <= 0 ? 0 : null;
  const base = metrics.clip?.channel ?? 0;
  const x = Math.min(ev, 0.05 * curve.length) / 0.05;
  const lo = Math.floor(x), hi = Math.ceil(x);
  const at = i => (i <= 0 ? base : curve[Math.min(i, curve.length) - 1]);
  const f = at(lo) + (at(hi) - at(lo)) * (x - lo);
  return Math.max(0, f - base);
}

function reliablePreview(m) {
  return !m?.width || Math.max(m.width, m.height || 0) >= LIMITS.minPreviewEdge;
}
function faceLuma(p) {
  const s = p.metrics?.subject;
  if (s?.method !== 'face' || !(s.luma > LIMITS.minFaceLuma) || !reliablePreview(p.metrics)) return null;
  return (s.area ?? 1) >= LIMITS.minFaceArea ? s.luma : null;
}
function aiExposureEV(p) {
  const v = p.ai?.proposed?.Exposure2012;
  if (typeof v === 'number' && typeof p.baseline.Exposure2012 === 'number') return v - p.baseline.Exposure2012;
  return p.ai?.subjectExposure === 'ok' ? 0 : null;
}
function boundsAround(baseline, origin, cap) {
  return [Math.max(baseline - cap, origin - cap), Math.min(baseline + cap, origin + cap)];
}

// Corrections the on-device measurements confirm independently of the model's own number:
// a face that is measurably very dark when the model says "under", and a white-balance
// direction the measured white surfaces agree with.
function corroboration(p) {
  const face = faceLuma(p);
  return {exposure: p.ai.subjectExposure === 'under' && face !== null && face < LIMITS.veryDarkFace,
    wb: p.wbEvidence?.source === 'ai+measured' && !p.wbEvidence.disagree};
}

// The evidence ladder. At or above the bar everything goes ahead. Between the floor and the
// bar only the corrections the measurements confirm go ahead (`only`); otherwise the photo is
// flagged for the photographer. Below the floor nothing is changed.
function gate(p, policy) {
  if (p.state === 'unsupported') return {status: 'unsupported'};
  if (!p.ai) return {status: 'flagged', reason: 'AI assessment unavailable' + (p.aiError ? ': ' + p.aiError : '') + '. Nothing will be changed.'};
  if (p.ai.skip) return {status: 'skipped', reason: p.ai.reason || 'The assessment found nothing that needs correcting.'};
  const conf = p.ai.confidence, pct = Math.round((conf || 0) * 100) + '%';
  if (conf >= policy.minConfidence) return null;
  const confirmed = conf >= policy.corroboratedConfidence ? corroboration(p) : null;
  if (confirmed && (confirmed.exposure || confirmed.wb)) return {only: confirmed, pct, bar: Math.round(policy.minConfidence * 100) + '%'};
  return {status: 'flagged', reason: 'Below the evidence threshold (' + Math.round(policy.minConfidence * 100) + '%; model reported ' + pct + ', uncalibrated)' +
    (confirmed ? " and the measurements don't confirm it" : '') + '. ' + (p.ai.reason || '')};
}

// Scene target = median of the implied targets that agree with each other. A frame
// whose implied target is far from the rest (a different subject, a misjudgment) keeps
// its own assessment instead of dragging the whole scene with it.
export function sceneExposureTarget(anchors, biasEV) {
  if (!anchors.length) return {target: null, agreeing: [], outliers: []};
  const logs = anchors.map(a => ({id: a.id, v: Math.log2(a.face) + a.ev}));
  const m = median(logs.map(l => l.v));
  const agreeing = logs.filter(l => Math.abs(l.v - m) <= LIMITS.sceneDisagreementEV / 2);
  const outliers = logs.filter(l => !agreeing.includes(l)).map(l => l.id);
  const enough = anchors.length === 1 || agreeing.length >= Math.max(2, Math.ceil(anchors.length / 2));
  if (!enough) return {target: null, agreeing: [], outliers: logs.map(l => l.id)};
  return {target: 2 ** (median(agreeing.map(l => l.v)) + biasEV), agreeing: agreeing.map(l => l.id), outliers};
}

function decideExposure(scene, eligible, policy, out) {
  const anchors = eligible.filter(p => out[p.id].allow.exposure && faceLuma(p) && aiExposureEV(p) !== null)
    .map(p => ({id: p.id, face: faceLuma(p), ev: aiExposureEV(p)}));
  const {target, agreeing, outliers} = sceneExposureTarget(anchors, policy.exposureBiasEV);
  // Faces differ for two reasons: exposure, and the people themselves. Frames with the same
  // effective exposure (camera settings plus the photo's current Lightroom exposure) in the
  // same light differ because of their subjects (a darker or lighter complexion, a turned
  // face): they all get the scene's shared judgment rather than being pulled to one face.
  // Flash output varies shot to shot, so flash frames are always matched by face.
  const effectiveEV = Object.fromEntries(eligible.map(p => {
    const f = sceneFeatures(p);
    return [p.id, scene.flash || f.flash || !Number.isFinite(f.ev) ? null : f.ev - (p.baseline.Exposure2012 || 0)];
  }));
  const referenceEV = median(agreeing.map(id => effectiveEV[id]).filter(Number.isFinite));
  const sameExposure = p => Number.isFinite(effectiveEV[p.id]) && Number.isFinite(referenceEV) &&
    Math.abs(effectiveEV[p.id] - referenceEV) < LIMITS.sameCameraExposureEV;
  const shared = agreeing.length ? median(anchors.filter(a => agreeing.includes(a.id)).map(a => a.ev)) : null;
  for (const p of eligible) {
    const d = out[p.id];
    if (!d.allow.exposure) continue;
    if (outliers.includes(p.id))
      d.warnings.push('Judged differently from the rest of this scene; its own assessment was used.');
    let ev = null, why;
    const face = faceLuma(p);
    // Name the look when it, not a correction, is what moves exposure.
    const look = policy.exposureBiasEV ? ', including the ' + policy.look + ' look (' + signed(policy.exposureBiasEV, 1) + ' EV target)' : '';
    if (target !== null && face && !outliers.includes(p.id) && sameExposure(p) && shared !== null) {
      ev = shared + policy.exposureBiasEV;
      why = 'Same exposure and light as this scene: its shared judgment (' + agreeing.length + ' frame' + (agreeing.length > 1 ? 's' : '') +
        ') was used, keeping differences between people' + look;
    } else if (target !== null && face && !outliers.includes(p.id)) {
      ev = Math.log2(target / face);
      why = 'Face brightness matched to the scene (' + agreeing.length + ' agreeing frame' + (agreeing.length > 1 ? 's' : '') + look + ')';
    } else if (aiExposureEV(p) !== null) {
      ev = aiExposureEV(p) + policy.exposureBiasEV;
      const s = p.metrics?.subject;
      why = (aiExposureEV(p) === 0 && policy.exposureBiasEV ? policy.look + ' look brightens subjects (exposure was judged correct)'
        : 'Per-photo assessment' + look) + (face ? '' : s?.method === 'face' ? ' — face too small to measure reliably' : ' — no face found');
    }
    if (ev === null) continue;
    ev *= policy.fraction;
    if (Math.abs(ev) < policy.exposureDeadbandEV) {
      if (Math.abs(ev) > 0.01) d.rationale.push('Exposure within ±' + policy.exposureDeadbandEV + ' EV of target; left unchanged.');
      continue;
    }
    if (ev > 0) {
      const clipped = newClipFraction(p.metrics, ev);
      if (clipped === null) d.warnings.push('Highlights were not measured; check bright areas after applying.');
      else if (clipped > policy.maxNewClipFraction) {
        let safe = ev;
        while (safe > 0 && newClipFraction(p.metrics, safe) > policy.maxNewClipFraction) safe -= 0.05;
        safe = Math.max(0, safe);
        d.rationale.push('Brightening limited to ' + signed(safe) + ' EV to protect highlight detail.');
        ev = safe;
        if (ev < policy.exposureDeadbandEV) continue;
      }
    }
    const base = p.baseline.Exposure2012, origin = p.origin?.Exposure2012 ?? base;
    const [lo, hi] = boundsAround(base, origin, policy.caps.Exposure2012);
    const value = roundSetting('Exposure2012', clamp(base + ev, lo, hi));
    if (Math.abs(value - (base + ev)) > 0.011) {
      d.rationale.push('Limited by the ' + policy.strength + ' cap' + (origin !== base ? ' (cumulative with an earlier TonePilot edit)' : '') + '.');
    }
    if (Math.abs(value - base) >= 0.01) {
      d.changes.Exposure2012 = value;
      d.rationale.unshift(why + ': ' + signed(value - base) + ' EV.');
    }
  }
}

function decideWhiteBalance(scene, eligible, policy, out) {
  decideRelativeWhiteBalance(eligible.filter(p => out[p.id].allow.wb && p.capabilities?.wbMode === 'relative'), policy, out);
  const wb = eligible.filter(p => out[p.id].allow.wb && p.capabilities?.wbMode !== 'relative');
  if (!wb.length) return;
  // A half-way change made on a measurement alone stays on its own photo: it never sets the scene.
  const assessed = wb.filter(p => p.wbEvidence?.source !== 'measured');
  const aiTemps = assessed.filter(p => typeof p.ai.proposed?.Temperature === 'number');
  const aiTints = assessed.filter(p => typeof p.ai.proposed?.Tint === 'number');
  let targetMired = null, targetTint = null, source = null;
  if (aiTemps.length) { targetMired = median(aiTemps.map(p => mired(p.ai.proposed.Temperature))); source = 'assessed'; }
  if (aiTints.length) targetTint = median(aiTints.map(p => p.ai.proposed.Tint));
  if (!aiTemps.length && wb.length >= 3 && scene.flash !== null) {
    const current = wb.map(p => mired(p.baseline.Temperature));
    if (Math.max(...current) - Math.min(...current) > LIMITS.wbDriftMired) { targetMired = median(current); source = 'drift'; }
    if (!aiTints.length) {
      const tints = wb.map(p => p.baseline.Tint);
      if (Math.max(...tints) - Math.min(...tints) > 4) targetTint = median(tints);
    }
  }
  for (const p of wb) {
    const d = out[p.id];
    const baseM = mired(p.baseline.Temperature), originM = mired(p.origin?.Temperature ?? p.baseline.Temperature);
    const own = typeof p.ai.proposed?.Temperature === 'number' ? mired(p.ai.proposed.Temperature) : null;
    // A photo with its own skin evidence is corrected for its own skin, never dragged to the
    // scene's median; the scene only guides frames that have no skin evidence of their own.
    const alone = ['ai', 'ai+measured', 'measured'].includes(p.wbEvidence?.source);
    let tgt = alone ? own : targetMired;
    if (!alone && own !== null && tgt !== null && Math.abs(own - tgt) > LIMITS.wbOutlierMired) {
      tgt = own;
      d.warnings.push('This frame\'s light looks different from the rest of its scene; its own white balance was used.');
    }
    if (tgt !== null) {
      let dm = (tgt - baseM) * policy.fraction;
      if (Math.abs(dm) >= LIMITS.wbDeadbandMired) {
        const [lo, hi] = boundsAround(baseM, originM, policy.caps.TemperatureMired);
        const m = clamp(baseM + dm, lo, hi);
        let k = roundSetting('Temperature', kelvin(m));
        // A whole Kelvin is a bigger step in mired at low temperatures, so rounding can land
        // just outside the limit (2900 K → 3079 K is 20.05 mired against 20): step back inside.
        for (let i = 0; i < 100 && (mired(k) < lo - 1e-9 || mired(k) > hi + 1e-9); i++) k += k > p.baseline.Temperature ? -1 : 1;
        if (Math.abs(k - p.baseline.Temperature) >= 1) {
          d.changes.Temperature = k;
          d.rationale.push((source === 'drift' && !alone ? 'White balance synced to the scene (auto white balance drifted between frames)' :
            alone ? 'White balance set for the skin' : 'White balance aligned with the scene') + ': ' + p.baseline.Temperature + ' K → ' + k + ' K.');
          if (Math.abs(m - (baseM + dm)) > 0.5) d.rationale.push('Temperature limited by the ' + policy.strength + ' cap.');
        }
      }
    }
    const ownTint = typeof p.ai.proposed?.Tint === 'number' ? p.ai.proposed.Tint : null;
    const tTint = alone ? ownTint : targetTint !== null && ownTint !== null && Math.abs(ownTint - targetTint) > 8 ? ownTint : targetTint;
    if (tTint !== null) {
      const dt = (tTint - p.baseline.Tint) * policy.fraction;
      if (Math.abs(dt) >= LIMITS.tintDeadband) {
        const origin = p.origin?.Tint ?? p.baseline.Tint;
        const [lo, hi] = boundsAround(p.baseline.Tint, origin, policy.caps.Tint);
        const v = roundSetting('Tint', clamp(p.baseline.Tint + dt, lo, hi));
        if (v !== p.baseline.Tint) {
          d.changes.Tint = v;
          d.rationale.push('Tint ' + signed(v - p.baseline.Tint, 0) + (p.ai.skinCast === 'green' || p.ai.skinCast === 'magenta' ? ' to reduce a ' + p.ai.skinCast + ' skin cast.' : ' for scene consistency.'));
        }
      }
    }
  }
}

// JPEG/HEIC/TIFF white balance is relative to each frame's own as-shot rendering
// (IncrementalTemperature/Tint, 0 = as shot), so there is no common Kelvin to sync to.
// Each frame keeps its own assessed correction; within a scene, corrections that agree
// are blended toward their median so the same light gets the same treatment.
function decideRelativeWhiteBalance(photos, policy, out) {
  for (const [key, cap, words] of [['IncrementalTemperature', policy.caps.IncrementalTemperature, ['warmer', 'cooler']],
                                    ['IncrementalTint', policy.caps.Tint, ['more magenta', 'more green']]]) {
    const own = p => typeof p.ai.proposed?.[key] === 'number' ? p.ai.proposed[key] - p.baseline[key] : null;
    const proposals = photos.map(own).filter(x => x !== null);
    const sceneDelta = proposals.length >= 2 ? median(proposals) : null;
    for (const p of photos) {
      const d = out[p.id], mine = own(p);
      if (mine === null) continue;
      let delta = mine;
      if (sceneDelta !== null) {
        if (Math.abs(mine - sceneDelta) <= LIMITS.relativeWbAgreement) delta = (mine + sceneDelta) / 2;
        else d.warnings.push('This frame\'s colour was judged differently from the rest of its scene; its own correction was used.');
      }
      delta *= policy.fraction;
      if (Math.abs(delta) < LIMITS.tintDeadband) continue;
      const base = p.baseline[key], origin = p.origin?.[key] ?? base;
      const [lo, hi] = boundsAround(base, origin, cap);
      const v = roundSetting(key, clamp(base + delta, lo, hi));
      if (v === base) continue;
      d.changes[key] = v;
      const cast = key === 'IncrementalTint' && (p.ai.skinCast === 'green' || p.ai.skinCast === 'magenta') ? ' to reduce a ' + p.ai.skinCast + ' skin cast'
        : key === 'IncrementalTemperature' && (p.ai.skinCast === 'too-cool' || p.ai.skinCast === 'too-warm') ? ' — skin looked ' + p.ai.skinCast.replace('too-', 'too ') : '';
      d.rationale.push('White balance ' + (key === 'IncrementalTint' ? 'tint ' : '') + words[v > base ? 0 : 1] + ' by ' + Math.abs(v - base) + cast +
        (sceneDelta !== null && Math.abs(mine - sceneDelta) <= LIMITS.relativeWbAgreement ? ' (consistent with its scene)' : '') + '.');
      if (Math.abs(v - (base + delta)) > 0.5) d.rationale.push('White balance limited by the ' + policy.strength + ' cap.');
    }
  }
}

function decideTone(scene, eligible, policy, out) {
  const tone = eligible.filter(p => out[p.id].allow.tone);
  for (const key of TONE_KEYS) {
    const proposals = tone.filter(p => typeof p.ai.proposed?.[key] === 'number' && typeof p.baseline[key] === 'number');
    const sceneDelta = proposals.length >= 2 ? median(proposals.map(p => p.ai.proposed[key] - p.baseline[key])) : null;
    for (const p of tone) {
      if (typeof p.baseline[key] !== 'number') continue;
      const d = out[p.id];
      const own = typeof p.ai.proposed?.[key] === 'number' ? p.ai.proposed[key] - p.baseline[key] : null;
      const delta = own !== null && sceneDelta !== null ? (own + sceneDelta) / 2 : own;
      const bias = policy.toneBias[key] || 0;
      const total = ((delta ?? 0) + bias) * policy.fraction;
      if (Math.abs(total) < LIMITS.toneDeadband) continue;
      const base = p.baseline[key], origin = p.origin?.[key] ?? base;
      const [lo, hi] = boundsAround(base, origin, policy.caps[key]);
      const v = roundSetting(key, clamp(base + total, lo, hi));
      if (v === base) continue;
      d.changes[key] = v;
      const label = key.replace('2012', '');
      d.rationale.push(label + ' ' + signed(v - base, 0) + (bias && !delta ? ' (' + policy.look + ' look)' : bias ? ' (assessment + ' + policy.look + ' look)' : sceneDelta !== null && own !== null ? ' (blended with scene)' : '') + '.');
    }
  }
}

// Advisory only. Different people legitimately differ, so only large, well-measured
// faces count, and the result is a "check this" note, never a correction.
// Always say what the skin-tone check concluded, including "no change" and why.
function skinToneLine(p, d) {
  const st = p.ai.skinTone, relative = p.capabilities?.wbMode === 'relative';
  const wbChanged = ['Temperature', 'Tint', 'IncrementalTemperature', 'IncrementalTint'].some(k => k in d.changes);
  const ev = p.wbEvidence;
  if (ev?.source === 'measured' || ev?.source === 'deliberate' || ev?.source === 'advisory') {
    const what = ev.cast.source + ' measure ' + describeCast(ev.cast) + ' (a* ' + signed(ev.cast.a, 1) + ', b* ' + signed(ev.cast.b, 1) + ')';
    const ai = st?.verdict === 'correct' ? 'Skin judged natural by the AI, but ' : '';
    if (ev.source === 'deliberate') return ai + what + ' — kept, the light colour looks deliberate.';
    if (ev.source === 'advisory') return ai + what + ' — advisory only' + (wbChanged ? '; white balance aligned with the scene.' : '; without a white reference that is not enough to change white balance.');
    return ai + what + (wbChanged ? ' — corrected half-way from the measurement.' : ' — too small to change.');
  }
  if (ev?.source === 'ai+measured') {
    return 'Skin tone ' + st.verdict.replaceAll('-', ' ') + ' (AI); ' + ev.cast.source + ' measure ' + describeCast(ev.cast) + ' (a* ' + signed(ev.cast.a, 1) +
      ', b* ' + signed(ev.cast.b, 1) + ')' + (wbChanged ? ' — amount averaged with the measurement.' : ' — too small to change.');
  }
  if (!st) return 'White balance checked — nothing to change.';
  if (st.verdict === 'correct') return 'Skin tone judged natural — ' + (wbChanged ? 'white balance aligned with the scene.' : 'white balance left as shot.');
  if (st.verdict === 'no-skin') return 'No skin visible — white balance follows the scene only.';
  if (st.verdict === 'mixed-light') return 'Mixed light on skin — white balance left for you to judge.';
  const ask = [st.temperatureShift ? (st.temperatureShift > 0 ? '+' : '') + Math.round(st.temperatureShift) + (relative ? '' : ' K') + ' temperature' : null,
    st.tintShift ? (st.tintShift > 0 ? '+' : '') + Math.round(st.tintShift) + ' tint' : null].filter(Boolean).join(', ') || 'no change';
  return 'Skin tone ' + st.verdict.replaceAll('-', ' ') + ': AI suggested ' + ask + (wbChanged ? '.' : ' — below the smallest change TonePilot makes, so white balance was left as shot.');
}

function skinHueWarnings(scenePhotos, out) {
  const hueOf = p => {
    const f = p.metrics?.faces?.[0];
    return f && typeof f.hue === 'number' && (f.area ?? 1) >= 0.01 && reliablePreview(p.metrics) ? f.hue : null;
  };
  const hues = scenePhotos.map(hueOf).filter(h => h !== null);
  if (hues.length < 3) return;
  const m = median(hues);
  for (const p of scenePhotos) {
    const h = hueOf(p);
    if (typeof h === 'number' && Math.abs(h - m) > LIMITS.skinHueWarnDeg && out[p.id])
      out[p.id].warnings.push('Skin hue differs from the rest of this scene by ' + Math.round(Math.abs(h - m)) + '°; check for mixed light or a colour cast.');
  }
}

const VERDICT_CAST = {'too-warm': 'too-warm', 'too-cool': 'too-cool', 'too-green': 'green', 'too-magenta': 'magenta',
  'too-warm-and-green': 'green', 'too-warm-and-magenta': 'magenta', 'too-cool-and-green': 'green', 'too-cool-and-magenta': 'magenta'};

// White-balance evidence, in priority order:
//   1. the model's skin-tone verdict with a non-zero shift;
//   2. otherwise a cast measured on bright neutral surfaces (white clothing, trim, sky),
//      converted to slider moves by colour science (colour.mjs) —
//   unless the light colour is deliberate (golden hour/tungsten warmth, creative colour,
//   mixed light). Both become absolute proposals in the photo's own units (Kelvin for
//   RAW, relative steps for JPEG/HEIC/TIFF); scene + policy logic takes it from there.
// A measured component too small to act on can't agree or disagree with anything.
function significant(key, shift, baseline) {
  if (key === 'Temperature') return Math.abs(mired(baseline.Temperature) - mired(baseline.Temperature + shift)) >= LIMITS.wbDeadbandMired;
  return Math.abs(shift) >= 2;
}

export function withSkinTone(p) {
  if (!p.capabilities?.wb || !p.ai) return p;
  const st = p.ai.skinTone;
  if (st?.verdict === 'mixed-light') return p;   // an older session; the model is no longer offered this verdict
  const relative = p.capabilities.wbMode === 'relative';
  const [tKey, iKey] = relative ? ['IncrementalTemperature', 'IncrementalTint'] : ['Temperature', 'Tint'];
  if (typeof p.baseline[tKey] !== 'number' || typeof p.baseline[iKey] !== 'number') return p;
  const proposed = {...p.ai.proposed};
  const cast = measuredCast(p.metrics);
  const deliberate = !!cast && (p.ai.intent === 'creative-colour' || (['golden-hour', 'tungsten'].includes(p.ai.illuminant) && cast.b > 0));
  let measured = null;
  if (cast && !deliberate) {
    const c = relative ? relativeCorrectionForCast(cast) : correctionForCast(cast, p.baseline.Temperature);
    measured = {[tKey]: relative ? c.temperature : c.kelvin, [iKey]: c.tint};
  }
  const aiShift = st && st.verdict in VERDICT_CAST ? {[tKey]: st.temperatureShift || 0, [iKey]: st.tintShift || 0} : null;
  if (aiShift && (aiShift[tKey] || aiShift[iKey])) {
    // Two independent estimates: where they agree on direction the amount is their average
    // (neither is trusted to be the bigger, truer one); where they point opposite ways the
    // model's skin judgment stands and the photo is flagged for a look.
    let usedMeasurement = false, disagree = false;
    for (const k of [tKey, iKey]) {
      if (!aiShift[k]) continue;
      const m = measured && significant(k, measured[k], p.baseline) ? measured[k] : 0;
      const same = m && Math.sign(m) === Math.sign(aiShift[k]);
      disagree ||= !!(m && !same);
      proposed[k] = p.baseline[k] + (same ? (m + aiShift[k]) / 2 : aiShift[k]);
      usedMeasurement ||= !!same;
    }
    return {...p, ai: {...p.ai, proposed, skinCast: VERDICT_CAST[st.verdict]},
      wbEvidence: {source: usedMeasurement ? 'ai+measured' : 'ai', cast, disagree}};
  }
  if (!cast) return p;
  if (deliberate) return {...p, wbEvidence: {source: 'deliberate', cast}};
  // The model judged the skin natural. A measurement alone is weaker evidence: tinted
  // clothing, walls or the photographer's profile can look like a cast. Only a real white
  // reference may move white balance, and only half-way; anything else is advisory.
  if (cast.source !== 'white surfaces') return {...p, wbEvidence: {source: 'advisory', cast}};
  for (const k of [tKey, iKey]) proposed[k] = p.baseline[k] + measured[k] / 2;
  return {...p, ai: {...p.ai, proposed}, wbEvidence: {source: 'measured', cast}};
}

// photos: [{id, state, baseline, origin, capabilities, metrics, ai, aiError}]; scenes from groupScenes.
export function decide({photos: input, scenes, policy, enabled}) {
  const photos = input.map(withSkinTone);
  const byId = Object.fromEntries(photos.map(p => [p.id, p]));
  const out = {};
  for (const scene of scenes) {
    const members = scene.photos.map(id => byId[id]).filter(Boolean);
    const eligible = [];
    for (const p of members) {
      const g = gate(p, policy);
      if (g?.status) { out[p.id] = {status: g.status, changes: {}, reason: g.reason || '', rationale: [], warnings: [], confidence: p.ai?.confidence ?? null}; continue; }
      // Deliberate looks are preserved in every direction; True to scene also keeps creative colour.
      const keep = KEEP_INTENT.has(p.ai.intent);
      const keepColour = policy.respectCreativeColour && p.ai.intent === 'creative-colour';
      const d = {status: 'skipped', changes: {}, reason: p.ai.reason || '', rationale: [], warnings: [], confidence: p.ai.confidence,
        allow: {exposure: enabled.exposure && p.capabilities?.exposure && !keep && (!g?.only || g.only.exposure),
          // Mixed light blocks only the guesswork (syncing to the scene); a skin correction goes ahead.
          wb: enabled.wb && p.capabilities?.wb && !keepColour && (!p.ai.mixedLighting || !!p.wbEvidence) && (!g?.only || g.only.wb),
          tone: enabled.tone && p.capabilities?.tone && !keep && !g?.only}};
      if (g?.only) d.rationale.push('Model confidence ' + g.pct + ' is below ' + g.bar + ', so only what the on-device measurements independently confirm was applied: ' +
        [g.only.exposure ? 'face brightness' : null, g.only.wb ? 'white surfaces agreeing on the skin cast' : null].filter(Boolean).join(' and ') + '.');
      if (keep) d.rationale.push('Kept the intentional ' + p.ai.intent + ' look.');
      if (keepColour) d.rationale.push('Kept the deliberate colour of the light.');
      if (enabled.wb && !p.capabilities?.wb) d.warnings.push(p.capabilities?.wbNote || 'White balance cannot be changed for this file.');
      if (enabled.wb && p.capabilities?.wb && p.ai.mixedLighting) d.warnings.push(p.wbEvidence
        ? 'Mixed light in the frame: white balance was set for the skin, so the background may look different.'
        : 'Mixed lighting: white balance left for you to judge.');
      out[p.id] = d; eligible.push(p);
    }
    decideExposure(scene, eligible, policy, out);
    decideWhiteBalance(scene, eligible, policy, out);
    decideTone(scene, eligible, policy, out);
    skinHueWarnings(members, out);
    for (const p of eligible) {
      const d = out[p.id];
      if (d.allow.wb && (p.ai.skinTone || p.wbEvidence)) d.rationale.push(skinToneLine(p, d));
      if (d.allow.wb && p.wbEvidence?.disagree) d.warnings.push('The AI and the measured ' + p.wbEvidence.cast.source + ' disagree on the white-balance direction; check this photo.');
      if (p.wbEvidence?.source === 'measured' && ['Temperature', 'Tint', 'IncrementalTemperature', 'IncrementalTint'].some(k => k in d.changes))
        d.warnings.push('White balance changed on the measurement alone (the AI judged the skin natural); check this photo.');
      delete d.allow;
      if (!Object.keys(d.changes).length) {
        d.status = 'skipped';
        if (!d.reason) d.reason = 'Already consistent with its scene; nothing to change.';
        continue;
      }
      try {
        validateSettings({origin: p.origin, baseline: p.baseline, proposed: d.changes, enabled, caps: policy.caps});
        d.status = 'proposed';
      } catch (e) {
        d.status = 'flagged'; d.reason = 'Blocked by safety limits: ' + e.message; d.changes = {};
      }
    }
  }
  return out;
}
