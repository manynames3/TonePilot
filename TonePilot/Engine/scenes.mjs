// Lighting-scene grouping. A wedding is shot as a sequence; a new lighting scene starts
// when the photographer moves, the light changes, or the camera body changes. Grouping
// is deliberately conservative: a false split only loses some consistency, a false
// merge could pull a tungsten reception toward window light.
import {mired} from './policy.mjs';

export const SCENE_RULES = Object.freeze({
  hardGapMinutes: 30, softGapMinutes: 5,
  evMajor: 2.0, evMinor: 1.2,          // metered scene light, EV100
  wbMajorMired: 30, wbMinorMired: 15,  // as-shot / current Temperature setting (RAW)
  visualMajor: 22, visualMinor: 14,    // mean ΔE76 over a 4×4 Lab grid
  visualMinGapMinutes: 1,
  breakScore: 1.5
});

const MONTHS = {jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11};

// Lightroom's formatted dateTimeOriginal is locale-dependent ("10/10/25 3:02:59 PM",
// "2025-10-10 15:02:59", "Oct 10, 2025 at 3:02:59 PM"). EXIF read by the analyzer is
// preferred; this is the fallback. Returns epoch ms or null.
export function parseCaptureTime(text) {
  if (!text) return null;
  const s = String(text).replace(/[  ]/g, ' ').trim();
  let m = s.match(/^(\d{4})[-:/](\d{2})[-:/](\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i);
  if (m) {
    let year = +m[3]; if (year < 100) year += 2000;
    let hour = +m[4];
    if (m[7]) { const pm = m[7].toUpperCase() === 'PM'; if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12; }
    return Date.UTC(year, +m[1] - 1, +m[2], hour, +m[5], +(m[6] || 0));   // M/D order (US locale)
  }
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})(?: at)? (\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i);
  if (m && m[1].toLowerCase() in MONTHS) {
    let hour = +m[4];
    if (m[7]) { const pm = m[7].toUpperCase() === 'PM'; if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12; }
    return Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2], hour, +m[5], +(m[6] || 0));
  }
  return null;
}

function numberFrom(text) {
  if (typeof text === 'number') return text;
  if (!text) return null;
  const frac = String(text).match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = String(text).match(/-?\d+(?:\.\d+)?/);
  return n ? Number(n[0]) : null;
}

// Metered scene brightness, EV at ISO 100: log2(N²/t) − log2(ISO/100).
export function ev100({fNumber, exposureTime, iso}) {
  const n = numberFrom(fNumber), t = numberFrom(exposureTime), i = numberFrom(iso);
  if (!(n > 0 && t > 0 && i > 0)) return null;
  return Math.log2(n * n / t) - Math.log2(i / 100);
}

export function gridDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length % 3) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i += 3) sum += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
  return sum / (a.length / 3);
}

// Lightroom formats flash as e.g. "Did fire" / "Did not fire" / "Off, Did not fire".
export function parseFlash(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  if (/not fire|did not|no flash|^off/.test(s)) return false;
  if (/fire/.test(s)) return true;
  return null;
}

// Normalizes what the engine knows about a photo into grouping features.
export function sceneFeatures(p) {
  const exif = p.metrics?.exif || {};
  const meta = p.exif || {};
  const captureMs = exif.captureTime ? parseCaptureTime(exif.captureTime) : parseCaptureTime(p.identity?.captureTime);
  return {
    id: p.id,
    captureMs: captureMs === null ? null : captureMs + (Number(exif.subsec) ? Number('0.' + exif.subsec) * 1000 : 0),
    camera: exif.model || meta.cameraModel || null,
    serial: meta.cameraSerialNumber || null,
    flash: typeof exif.flashFired === 'boolean' ? exif.flashFired : parseFlash(meta.flash),
    ev: ev100({fNumber: exif.fNumber ?? meta.aperture, exposureTime: exif.exposureTime ?? meta.shutterSpeed, iso: exif.iso ?? meta.isoSpeedRating}),
    wbMired: typeof p.baseline?.Temperature === 'number' ? mired(p.baseline.Temperature) : null,
    grid: p.metrics?.grid || null,
    subject: p.metrics?.subject || null,
    clip: p.metrics?.clip || null
  };
}

export function breakBetween(a, b, rules = SCENE_RULES) {
  const reasons = [];
  if (a.camera && b.camera && (a.camera !== b.camera || (a.serial && b.serial && a.serial !== b.serial)))
    return {split: true, reasons: ['different camera body']};
  if (a.flash !== null && b.flash !== null && a.flash !== b.flash)
    return {split: true, reasons: [b.flash ? 'flash turned on' : 'flash turned off']};
  const gap = a.captureMs !== null && b.captureMs !== null ? Math.abs(b.captureMs - a.captureMs) / 60000 : null;
  if (gap !== null && gap > rules.hardGapMinutes) return {split: true, reasons: [Math.round(gap) + ' min gap']};
  let score = 0;
  if (gap !== null && gap > rules.softGapMinutes) { score += 1; reasons.push(Math.round(gap) + ' min gap'); }
  if (a.ev !== null && b.ev !== null) {
    const d = Math.abs(a.ev - b.ev);
    if (d > rules.evMajor) { score += 1.5; reasons.push('light level changed ' + d.toFixed(1) + ' EV'); }
    else if (d > rules.evMinor) { score += 0.75; reasons.push('light level changed ' + d.toFixed(1) + ' EV'); }
  }
  if (a.wbMired !== null && b.wbMired !== null) {
    const d = Math.abs(a.wbMired - b.wbMired);
    if (d > rules.wbMajorMired) { score += 1.5; reasons.push('light colour changed ' + Math.round(d) + ' mired'); }
    else if (d > rules.wbMinorMired) { score += 0.75; reasons.push('light colour changed ' + Math.round(d) + ' mired'); }
  }
  // Surroundings describe content, not light: seconds apart, a different framing is
  // the same light. Visual change only counts fully once some time has also passed.
  const v = gridDistance(a.grid, b.grid);
  if (v !== null) {
    const settled = gap === null || gap > rules.visualMinGapMinutes;
    if (v > rules.visualMajor) { score += settled ? 1.5 : 0.5; reasons.push('different surroundings'); }
    else if (v > rules.visualMinor) { score += settled ? 0.75 : 0.25; reasons.push('surroundings changed'); }
  }
  return {split: score >= rules.breakScore, reasons, score};
}

// photos: engine photo records (identity, baseline, exif, metrics). Returns scenes in
// capture order: [{id, photos:[ids], reference, startedBecause:[...]}].
export function groupScenes(photos, rules = SCENE_RULES) {
  const feats = photos.map(sceneFeatures);
  const order = feats.map((f, i) => ({f, i})).sort((x, y) => {
    if (x.f.captureMs === null || y.f.captureMs === null) return x.i - y.i;
    return x.f.captureMs - y.f.captureMs || x.i - y.i;
  }).map(x => x.f);
  const scenes = [];
  let current = null, prev = null;
  for (const f of order) {
    const br = prev ? breakBetween(prev, f, rules) : {split: true, reasons: ['first photo']};
    if (!current || br.split) {
      current = {id: 'S' + (scenes.length + 1), photos: [], startedBecause: br.reasons, members: []};
      scenes.push(current);
    }
    current.photos.push(f.id); current.members.push(f);
    prev = f;
  }
  for (const sc of scenes) {
    sc.reference = chooseReference(sc.members);
    const times = sc.members.map(m => m.captureMs).filter(x => x !== null);
    sc.span = times.length ? {from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString()} : null;
    sc.flash = sc.members.every(m => m.flash === true) ? true : sc.members.every(m => m.flash === false) ? false : null;
    delete sc.members;
  }
  return scenes;
}

// Reference frame: a measured face, little clipping, subject brightness nearest the
// scene's median. It anchors review ("check this frame first") and AI context.
export function chooseReference(members) {
  const withFace = members.filter(m => m.subject?.method === 'face');
  const pool = withFace.length ? withFace : members;
  const lumas = pool.map(m => m.subject?.luma).filter(x => typeof x === 'number').sort((a, b) => a - b);
  const median = lumas.length ? lumas[Math.floor(lumas.length / 2)] : null;
  let best = pool[0], bestScore = Infinity;
  for (const m of pool) {
    const clip = m.clip?.channel ?? 0;
    const off = median && m.subject?.luma ? Math.abs(Math.log2(m.subject.luma / median)) : 0;
    const score = off + clip * 20;
    if (score < bestScore) { best = m; bestScore = score; }
  }
  return best?.id || null;
}
