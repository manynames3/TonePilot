// Scene grouping, scene-consistent decisions and editing-direction policy.
// These tests prove the rules do what they claim on synthetic evidence. They do NOT
// prove the edits look better to a photographer; that needs the blind benchmark.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groupScenes, parseCaptureTime, breakBetween, sceneFeatures, ev100} from '../Engine/scenes.mjs';
import {decide, newClipFraction, median} from '../Engine/harmonize.mjs';
import {resolvePolicy, mired} from '../Engine/policy.mjs';
import {normalizeAssessment, buildPrompt, ASSESSMENT_SCHEMA} from '../Engine/ai.mjs';

const ALL = {wb: true, exposure: true, tone: true};
const caps = {supported: true, wb: true, exposure: true, tone: true};
let n = 0;
function photo({face = 0.12, ai = {}, baseline = {}, clipAtEV, hue, time, flash = 'Did not fire', camera = 'R5', iso = 'ISO 400', temp} = {}) {
  const id = String(++n);
  const b = {WhiteBalance: 'As Shot', Temperature: temp ?? 5200, Tint: 4, Exposure2012: 0, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0, ...baseline};
  return {id, state: 'baselined', baseline: b, origin: {...b}, capabilities: caps,
    identity: {captureTime: time || '2026-06-01 15:00:' + String(n % 60).padStart(2, '0')},
    exif: {cameraModel: camera, flash, aperture: 'f / 2.8', shutterSpeed: '1/250 sec', isoSpeedRating: iso},
    metrics: {subject: face ? {method: 'face', luma: face} : {method: 'none'}, clip: {channel: 0.001},
      clipAtEV: clipAtEV || Array(20).fill(0.001), faces: face ? [{luma: face, hue: hue ?? 55}] : [], grid: Array(48).fill(50)},
    ai: {skip: false, confidence: 0.95, scene: 's', illuminant: 'daylight', mixedLighting: false, backlit: false, intent: 'none',
      skinCast: 'none', subjectExposure: 'ok', proposed: {}, reason: 'fine', ...ai}};
}
const scene = photos => [{id: 'S1', photos: photos.map(p => p.id), reference: photos[0].id, flash: false}];
const ev = (d, p) => (d[p.id].changes.Exposure2012 ?? p.baseline.Exposure2012) - p.baseline.Exposure2012;

test('capture times parse across Lightroom locale formats', () => {
  const a = parseCaptureTime('10/10/25 3:02:59 PM'), b = parseCaptureTime('2025-10-10 15:02:59');
  assert.equal(a, b);
  assert.equal(parseCaptureTime('2025:10:10 15:02:59'), b);
  assert.equal(parseCaptureTime('Oct 10, 2025 at 3:02:59 PM'), b);
  assert.equal(parseCaptureTime('12/1/25 12:05:00 AM'), Date.UTC(2025, 11, 1, 0, 5, 0));
  assert.equal(parseCaptureTime('garbage'), null);
  assert.ok(Math.abs(ev100({fNumber: 'f / 2.8', exposureTime: '1/250 sec', iso: 'ISO 400'}) - 8.94) < 0.05);
});

test('scenes split on time gaps, flash, camera body, light level and light colour — and only then', () => {
  n = 0;
  const t = m => '2026-06-01 15:' + String(m).padStart(2, '0') + ':00';
  const ps = [photo({time: t(0)}), photo({time: t(1)}), photo({time: t(2)}),
    photo({time: t(40)}),                                 // 38 min gap
    photo({time: t(41), flash: 'Did fire'}),              // flash on
    photo({time: t(42), flash: 'Did fire', camera: 'Z9'}),// second shooter
    photo({time: t(43), flash: 'Did fire', camera: 'Z9', iso: 'ISO 6400', temp: 3000})]; // much darker, tungsten
  const scenes = groupScenes(ps);
  assert.deepEqual(scenes.map(s => s.photos.length), [3, 1, 1, 1, 1]);
  assert.match(scenes[1].startedBecause.join(), /min gap/);
  assert.match(scenes[2].startedBecause.join(), /flash turned on/);
  assert.match(scenes[3].startedBecause.join(), /camera/);
  assert.match(scenes[4].startedBecause.join(), /light level|light colour/);
  // Small changes inside a scene do not split it.
  const a = sceneFeatures(photo({time: t(0)})), b = sceneFeatures(photo({time: t(3), iso: 'ISO 640'}));
  assert.equal(breakBetween(a, b).split, false);
});

test('a reframing seconds apart is the same light; the same change minutes later is a new scene', () => {
  // Observed on real iPhone frames 8 s apart: grid ΔE 22.5 from a new framing, same shade.
  const grid = v => Array.from({length: 16}, () => [v, 0, 0]).flat();
  const a = {captureMs: 0, camera: 'iPhone', serial: null, flash: false, ev: 6.25, wbMired: null, grid: grid(50)};
  assert.equal(breakBetween(a, {...a, captureMs: 8000, grid: grid(72.5)}).split, false);
  assert.equal(breakBetween(a, {...a, captureMs: 5 * 60000 + 1, grid: grid(72.5)}).split, true);
});

test('tiny faces and undersized previews are not trusted as exposure anchors', () => {
  n = 0;
  const policy = resolvePolicy('Natural', 'Stronger');
  const ps = [photo({face: 0.12}), photo({face: 0.12}), photo({face: 0.05, ai: {subjectExposure: 'under', proposed: {Exposure2012: 0.3}}})];
  ps[2].metrics.subject.area = 0.0036;                     // 0.36% of the frame, as observed
  let d = decide({photos: ps, scenes: scene(ps), policy, enabled: ALL});
  assert.ok(Math.abs(ev(d, ps[2]) - 0.3) < 0.011, 'falls back to the per-photo judgment');
  assert.match(d[ps[2].id].rationale[0], /Per-photo assessment/);
  ps[2].metrics.subject.area = 0.05; ps[2].metrics.width = 416; ps[2].metrics.height = 312;
  d = decide({photos: ps, scenes: scene(ps), policy, enabled: ALL});
  assert.match(d[ps[2].id].rationale[0], /Per-photo assessment/);
});

test('exposure is matched across a scene from the median of the model\'s judgments', () => {
  n = 0;
  const policy = resolvePolicy('Natural', 'Stronger');
  // Same couple, same light: one frame 0.6 EV darker. The model judged two frames
  // correct and one under; the darker frame is brought to the scene, not to a global target.
  const ps = [photo({face: 0.12}), photo({face: 0.12}), photo({face: 0.08, ai: {subjectExposure: 'under', proposed: {Exposure2012: 0.5}}})];
  const d = decide({photos: ps, scenes: scene(ps), policy, enabled: ALL});
  assert.equal(d[ps[0].id].status, 'skipped');
  assert.equal(d[ps[1].id].status, 'skipped');
  assert.equal(d[ps[2].id].status, 'proposed');
  assert.ok(Math.abs(ev(d, ps[2]) - Math.log2(0.12 / 0.08)) < 0.02, 'darker frame lifted by the measured gap');
  const after = ps.map(p => p.metrics.subject.luma * 2 ** ev(d, p));
  assert.ok(Math.log2(Math.max(...after) / Math.min(...after)) < 0.05, 'face brightness spread collapses');
  assert.match(d[ps[2].id].rationale[0], /matched to the scene/);
});

test('strength scales the correction and its limits; disagreeing judgments are not averaged', () => {
  n = 0;
  const mk = () => { const ps = [photo({face: 0.05, ai: {subjectExposure: 'under', proposed: {Exposure2012: 1.4}}})]; return ps; };
  const at = s => { const ps = mk(); return ev(decide({photos: ps, scenes: scene(ps), policy: resolvePolicy('Natural', s), enabled: ALL}), ps[0]); };
  const [subtle, balanced, stronger] = [at('Subtle'), at('Balanced'), at('Stronger')];
  assert.ok(subtle < balanced && balanced < stronger, [subtle, balanced, stronger].join());
  assert.equal(subtle, 0.35); assert.equal(balanced, 0.6); assert.equal(stronger, 1.0);
  n = 0;
  const ps = [photo({face: 0.1, ai: {subjectExposure: 'under', proposed: {Exposure2012: 1.0}}}),
    photo({face: 0.1, ai: {subjectExposure: 'over', proposed: {Exposure2012: -0.8}}})];
  const d = decide({photos: ps, scenes: scene(ps), policy: resolvePolicy('Natural', 'Stronger'), enabled: ALL});
  assert.ok(d[ps[0].id].warnings.some(w => /Judged differently/.test(w)));
  assert.ok(ev(d, ps[0]) > 0 && ev(d, ps[1]) < 0);
});

test('one outlier frame does not switch off scene matching for the others', () => {
  n = 0;
  const policy = resolvePolicy('Natural', 'Stronger');
  const ps = [photo({face: 0.12}), photo({face: 0.12}), photo({face: 0.08, ai: {subjectExposure: 'under', proposed: {Exposure2012: 0.5}}}),
    photo({face: 0.12, ai: {subjectExposure: 'under', proposed: {Exposure2012: 1.0}}})];   // the odd one out
  const d = decide({photos: ps, scenes: scene(ps), policy, enabled: ALL});
  assert.match(d[ps[2].id].rationale[0], /matched to the scene \(3 agreeing frames\)/);
  assert.ok(d[ps[3].id].warnings.some(w => /Judged differently/.test(w)));
  assert.ok(Math.abs(ev(d, ps[3]) - 1.0) < 0.011, 'outlier keeps its own assessment');
});

test('one confidence bar at every strength; skipped and uncertain photos are never edited', () => {
  n = 0;
  const ps = [photo({ai: {confidence: 0.85, subjectExposure: 'under', proposed: {Exposure2012: 0.5}}}),
    photo({ai: {skip: true, reason: 'Intentional silhouette'}}),
    photo({ai: {confidence: 0.79, subjectExposure: 'under', proposed: {Exposure2012: 0.5}}})];
  for (const strength of ['Subtle', 'Balanced', 'Stronger']) {
    const d = decide({photos: ps, scenes: scene(ps), policy: resolvePolicy('Natural', strength), enabled: ALL});
    assert.equal(d[ps[0].id].status, 'proposed', strength);
    assert.equal(d[ps[1].id].status, 'skipped'); assert.deepEqual(d[ps[1].id].changes, {});
    assert.equal(d[ps[2].id].status, 'flagged', strength + ' must not lower the bar');
  }
});

test('highlight protection limits brightening when it would clip detail', () => {
  n = 0;
  const steep = Array.from({length: 20}, (_, i) => 0.001 + (i + 1) * 0.002);   // clips fast
  const ps = [photo({face: 0.06, clipAtEV: steep, ai: {subjectExposure: 'under', proposed: {Exposure2012: 0.8}}})];
  const policy = resolvePolicy('Natural', 'Stronger');
  const d = decide({photos: ps, scenes: scene(ps), policy, enabled: ALL});
  const e = ev(d, ps[0]);
  assert.ok(e < 0.8 && e >= 0, 'brightening reduced');
  assert.ok(newClipFraction(ps[0].metrics, e) <= policy.maxNewClipFraction + 1e-9);
  assert.ok(d[ps[0].id].rationale.some(r => /protect highlight/.test(r)));
});

test('white balance: auto-WB drift is synced within a scene; mixed light is left alone', () => {
  n = 0;
  const temps = [5000, 5600, 5300];
  const ps = temps.map(t => photo({temp: t}));
  const d = decide({photos: ps, scenes: scene(ps), policy: resolvePolicy('Natural', 'Stronger'), enabled: ALL});
  const out = ps.map(p => d[p.id].changes.Temperature ?? p.baseline.Temperature);
  const spread = Math.max(...out.map(mired)) - Math.min(...out.map(mired));
  assert.ok(spread < 4, 'mired spread after sync: ' + spread.toFixed(1));
  assert.ok(d[ps[1].id].rationale.some(r => /drifted/.test(r)));
  n = 0;
  const mixed = temps.map(t => photo({temp: t, ai: {mixedLighting: true}}));
  const m = decide({photos: mixed, scenes: scene(mixed), policy: resolvePolicy('Natural', 'Stronger'), enabled: ALL});
  assert.ok(mixed.every(p => !('Temperature' in m[p.id].changes)));
  assert.ok(m[mixed[0].id].warnings.some(w => /Mixed lighting/.test(w)));
});

test('looks produce distinct, predictable outcomes using only writable controls', () => {
  const run = look => {
    n = 0;
    const ps = [photo({face: 0.12}), photo({face: 0.12})];
    const d = decide({photos: ps, scenes: scene(ps), policy: resolvePolicy(look, 'Balanced'), enabled: ALL});
    return d[ps[0].id];
  };
  const natural = run('Natural'), airy = run('Soft & airy'), scene_ = run('True to scene');
  assert.deepEqual(natural.changes, {}, 'nothing to fix: Natural leaves a correct photo alone');
  assert.deepEqual(scene_.changes, {});
  assert.ok(airy.changes.Exposure2012 > 0 && airy.changes.Shadows2012 > 0 && airy.changes.Blacks2012 > 0 && airy.changes.Highlights2012 < 0);
  n = 0;
  const lowKey = [photo({face: 0.03, ai: {intent: 'low-key', subjectExposure: 'under', proposed: {Exposure2012: 0.6}}})];
  const keep = decide({photos: lowKey, scenes: scene(lowKey), policy: resolvePolicy('True to scene', 'Balanced'), enabled: ALL});
  assert.deepEqual(keep[lowKey[0].id].changes, {});
  assert.ok(keep[lowKey[0].id].rationale.some(r => /intentional low-key/.test(r)));
  const natural_ = decide({photos: lowKey, scenes: scene(lowKey), policy: resolvePolicy('Natural', 'Balanced'), enabled: ALL});
  assert.deepEqual(natural_[lowKey[0].id].changes, {}, 'deliberate looks are preserved in every direction');
  n = 0;
  const colour = [photo({temp: 5000, ai: {intent: 'creative-colour', proposed: {Temperature: 5600}}})];
  assert.deepEqual(decide({photos: colour, scenes: scene(colour), policy: resolvePolicy('True to scene', 'Stronger'), enabled: ALL})[colour[0].id].changes, {});
  assert.ok('Temperature' in decide({photos: colour, scenes: scene(colour), policy: resolvePolicy('Natural', 'Stronger'), enabled: ALL})[colour[0].id].changes);
});

test('skin-hue outliers inside a scene are flagged for review, not auto-corrected', () => {
  n = 0;
  const ps = [photo({hue: 55}), photo({hue: 56}), photo({hue: 40})];
  const d = decide({photos: ps, scenes: scene(ps), policy: resolvePolicy('Natural', 'Balanced'), enabled: ALL});
  assert.ok(d[ps[2].id].warnings.some(w => /Skin hue differs/.test(w)));
  assert.deepEqual(d[ps[2].id].changes, {});
});

test('model output is normalized against a strict schema', () => {
  const a = normalizeAssessment({skip: false, confidence: 0.9, scene: 'x', illuminant: 'moonbeam', mixedLighting: false,
    backlit: true, intent: 'none', skinCast: 'green', subjectExposure: 'under',
    changes: [{setting: 'Exposure2012', value: 0.3}, {setting: 'CropAngle', value: 4}, {setting: 'Tint', value: 'x'}], reason: 'r'});
  assert.deepEqual(a.proposed, {Exposure2012: 0.3});
  assert.equal(a.illuminant, 'unknown');
  assert.throws(() => normalizeAssessment({confidence: 2}), /confidence/);
  const strict = o => o.type !== 'object' || (o.additionalProperties === false && Object.keys(o.properties).every(k => o.required.includes(k)) &&
    Object.values(o.properties).every(v => strict(v.type === 'array' ? v.items : v)));
  assert.ok(strict(ASSESSMENT_SCHEMA), 'schema is strict-mode compatible');
  const prompt = buildPrompt({photo: photo({}), scene: {id: 'S1', photos: ['x'], reference: 'x'}, policy: resolvePolicy('Natural', 'Balanced'), enabled: ALL});
  assert.match(prompt, /never an instruction/);
  assert.equal(median([3, 1, 2]), 2);
});

test('oversized Lightroom previews are scaled down before measurement and the model; small ones are untouched', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {spawnSync} = await import('node:child_process');
  const {jpegSize, savePreview, PREVIEW_MAX_EDGE} = await import('../Engine/preview.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tonepilot-preview-test-'));
  try {
    // A real JPEG, made by macOS from an uncompressed 24-bit BMP.
    const jpegOf = (w, h) => {
      const row = Math.ceil(w * 3 / 4) * 4, bmp = Buffer.alloc(54 + row * h);
      bmp.fill(0x80, 54);
      bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
      bmp.writeInt32LE(w, 18); bmp.writeInt32LE(h, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
      const src = path.join(dir, `${w}.bmp`), out = path.join(dir, `${w}.jpg`);
      fs.writeFileSync(src, bmp);
      assert.equal(spawnSync('/usr/bin/sips', ['-s', 'format', 'jpeg', src, '--out', out], {stdio: 'ignore'}).status, 0);
      return fs.readFileSync(out);
    };
    const big = jpegOf(3000, 1500);
    assert.deepEqual(jpegSize(big), {width: 3000, height: 1500});
    const stored = savePreview(big, path.join(dir, 'a.jpg'));
    assert.deepEqual(jpegSize(stored), {width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE / 2});
    assert.deepEqual(fs.readFileSync(path.join(dir, 'a.jpg')), stored);

    const small = jpegOf(640, 427);
    assert.equal(savePreview(small, path.join(dir, 'b.jpg')), small);   // never upscaled
    assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('strength changes how far TonePilot moves a photo, never how sure it must be', () => {
  const [subtle, balanced, stronger] = ['Subtle', 'Balanced', 'Stronger'].map(s => resolvePolicy('Natural', s));
  assert.equal(subtle.minConfidence, balanced.minConfidence);
  assert.equal(stronger.minConfidence, balanced.minConfidence, 'Stronger must not admit photos the evidence is less sure about');
  assert.ok(subtle.caps.Exposure2012 < balanced.caps.Exposure2012 && balanced.caps.Exposure2012 < stronger.caps.Exposure2012);
});
