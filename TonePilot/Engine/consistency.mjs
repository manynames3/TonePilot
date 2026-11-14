// How consistent is skin across a lighting scene? Plain measurements from the on-device
// analyzer, reported before the plan, as planned (exposure only: the one thing a preview
// predicts well) and as measured from Lightroom's fresh previews after applying.
// Ranges across the frames with a reliably measured face; different people legitimately
// differ, so this is a comparison of before and after, not a score against zero.
import {KEEP_INTENT} from './harmonize.mjs';

const MIN_FACE_AREA = 0.004, MIN_EDGE = 500;
const face = m => {
  const s = m?.subject, f = m?.faces?.[0];
  if (s?.method !== 'face' || !(s.luma > 0.002) || (s.area ?? 1) < MIN_FACE_AREA) return null;
  if (m.width && Math.max(m.width, m.height || 0) < MIN_EDGE) return null;
  return {ev: Math.log2(s.luma), a: f?.lab?.[1] ?? null, b: f?.lab?.[2] ?? null};
};
const range = xs => { const v = xs.filter(Number.isFinite); return v.length > 1 ? Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100 : null; };
const summary = faces => ({frames: faces.length, brightnessEV: range(faces.map(f => f.ev)),
  tint: range(faces.map(f => f.a)), warmth: range(faces.map(f => f.b))});

// photos: session photos of one scene ({metrics, baseline, changes, state, post}).
export function sceneConsistency(photos) {
  // A deliberate look (silhouette, low-key) or a frame the model skipped is different on purpose: not counted.
  const rows = photos.filter(p => !p.ai?.skip && !KEEP_INTENT.has(p.ai?.intent)).map(p => ({p, f: face(p.metrics)})).filter(r => r.f);
  if (rows.length < 2) return null;
  const evChange = p => (p.changes?.Exposure2012 ?? p.baseline?.Exposure2012 ?? 0) - (p.baseline?.Exposure2012 ?? 0);
  // White-balance settings of the RAW frames: in one light they should end on the same values.
  const kelvin = photos.filter(p => typeof p.baseline?.Temperature === 'number' && typeof p.baseline?.Tint === 'number');
  const wb = pick => kelvin.length > 1 ? {whiteBalanceMired: range(kelvin.map(p => 1e6 / pick(p, 'Temperature'))), whiteBalanceTint: range(kelvin.map(p => pick(p, 'Tint')))} : {};
  const before = {...summary(rows.map(r => r.f)), ...wb((p, k) => p.baseline[k])};
  const planned = {frames: rows.length, brightnessEV: range(rows.map(r => r.f.ev + evChange(r.p))), ...wb((p, k) => p.changes?.[k] ?? p.baseline[k])};
  // Measured after applying: only when every frame that was changed has a fresh measurement.
  const present = p => p.state === 'applied' || p.state === 'apply-mismatch';
  const after = rows.map(r => present(r.p) ? face(r.p.post?.metrics) : r.f);
  const unsettled = rows.some(r => ['proposed', 'writing', 'restoring'].includes(r.p.state));   // half-way through: not a result yet
  const measured = !unsettled && rows.some(r => present(r.p)) && after.every(Boolean) ? summary(after) : null;
  return {before, planned, measured};
}

// One plain sentence for the scene header and the report.
export function consistencyLine(c) {
  if (!c || c.before.brightnessEV === null) return null;
  const ev = v => v.toFixed(2) + ' EV';
  const head = 'Skin brightness across ' + c.before.frames + ' faces: ';
  const moved = Math.abs(c.planned.brightnessEV - c.before.brightnessEV) >= 0.01;
  if (c.measured?.brightnessEV != null) return head + ev(c.before.brightnessEV) + ' apart before → ' + ev(c.measured.brightnessEV) + ' measured after applying';
  // Wider only when a frame was left for the photographer while its neighbours were corrected.
  const wider = c.planned.brightnessEV > c.before.brightnessEV + 0.05 ? ' (wider until the photos left for you are adjusted)' : '';
  return moved ? head + ev(c.before.brightnessEV) + ' apart → ' + ev(c.planned.brightnessEV) + ' planned' + wider
    : head + ev(c.before.brightnessEV) + ' apart, unchanged by this plan';
}
