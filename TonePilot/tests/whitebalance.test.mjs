// White balance on JPEG/HEIC/TIFF (Lightroom's relative IncrementalTemperature/Tint),
// the exposure-and-white-balance-only scope, and explanations that name the look.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup, rawPhoto} from './helpers.mjs';
import {decide, withSkinTone} from '../Engine/harmonize.mjs';
import {resolvePolicy} from '../Engine/policy.mjs';
import {buildPrompt} from '../Engine/ai.mjs';
import {capabilitiesOf, restorePlan} from '../Engine/guard.mjs';

const heic = (name, extra = {}) => rawPhoto(name, {fileFormat: 'HEIC', ...extra,
  settings: {whiteBalance: 'As Shot', incrementalTemperature: 0, incrementalTint: 0, exposure: 0, contrast: 0,
    highlights: -30, shadows: 20, whites: -10, blacks: -40, ...(extra.settings || {})}});
const COOL = {skip: false, confidence: 0.92, scene: 'open shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
  intent: 'none', skinCast: 'too-cool', subjectExposure: 'ok',
  changes: [{setting: 'IncrementalTemperature', value: 12}], reason: 'Shade has turned skin slightly blue.'};

test('HEIC white balance is proposed, written, verified and restored to As Shot', () => {
  const x = setup({photos: {301: heic('IMG_9101.HEIC')}, extra: {aiDefault: COOL}});
  try {
    const dir = x.analyze(['301']);
    let v = x.show(dir);
    const p = v.photos[0];
    assert.equal(p.state, 'proposed');
    assert.deepEqual(p.changes.map(c => [c.key, c.label, c.original, c.proposed]), [['IncrementalTemperature', 'Temperature', 0, 10]]);
    assert.match(p.rationale.join(' '), /White balance warmer by 10/);
    assert.ok(!p.warnings.some(w => /left unchanged/.test(w)));
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 0);
    v = x.show(dir);
    assert.equal(v.photos[0].state, 'applied', JSON.stringify(v.photos[0].write));
    assert.equal(x.get().photos[301].settings.incrementalTemperature, 10);
    assert.equal(x.get().photos[301].settings.whiteBalance, 'Custom', 'Lightroom flips the mode; that is allowed');
    assert.equal(x.run(['--mode', 'restore', '--session', dir, '--confirm']).status, 0);
    const s = x.get().photos[301].settings;
    assert.equal(x.show(dir).status, 'restored');
    assert.deepEqual([s.whiteBalance, s.incrementalTemperature, s.incrementalTint], ['As Shot', 0, 0]);
  } finally { x.cleanup(); }
});

test('a bridge that reports but cannot write relative white balance gets an explicit, honest skip', () => {
  const x = setup({photos: {301: heic('IMG_9101.HEIC')}, extra: {aiDefault: COOL}});
  try {
    const r = x.run(['--mode', 'analyze', '--ids', '["301"]'], {TONEPILOT_MOCK_NO_RELATIVE_WB: '1'});
    const p = x.show(r.complete.dir).photos[0];
    assert.equal(p.changes.length, 0);
    assert.ok(p.warnings.some(w => /does not accept writing/.test(w)));
    assert.equal(x.get().writes.length, 0);
  } finally { x.cleanup(); }
});

test('with the stock 0.24.1 bridge (no relative fields at all) the reason is stated, not hidden', () => {
  const stock = rawPhoto('IMG_9102.HEIC', {fileFormat: 'HEIC', settings: {whiteBalance: 'As Shot', exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0}});
  const caps = capabilitiesOf({fileFormat: 'HEIC'}, {WhiteBalance: 'As Shot', Exposure2012: 0, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0},
    new Set(['IncrementalTemperature', 'IncrementalTint']));
  assert.equal(caps.wb, false);
  assert.match(caps.wbNote, /cannot read or write/);
  assert.ok(stock);
});

test('relative corrections that agree are blended across the scene; an outlier keeps its own', () => {
  const photo = (id, temp) => ({id, state: 'baselined', capabilities: {supported: true, wb: true, wbMode: 'relative', exposure: true, tone: true},
    baseline: {WhiteBalance: 'As Shot', IncrementalTemperature: 0, IncrementalTint: 0, Exposure2012: 0, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0},
    origin: null, metrics: null,
    ai: {skip: false, confidence: 0.95, intent: 'none', mixedLighting: false, skinCast: 'too-cool', subjectExposure: 'ok',
      proposed: {IncrementalTemperature: temp}, reason: 'cool'}});
  const ps = [photo('a', 12), photo('b', 8), photo('c', 30)];
  const d = decide({photos: ps, scenes: [{id: 'S1', photos: ['a', 'b', 'c'], flash: false}], policy: resolvePolicy('Natural', 'Stronger'),
    enabled: {wb: true, exposure: true, tone: true}});
  assert.equal(d.a.changes.IncrementalTemperature, 12, 'median of 12, 8, 30 is 12');
  assert.equal(d.b.changes.IncrementalTemperature, 10, '(8 + 12) / 2');
  assert.equal(d.c.changes.IncrementalTemperature, 15, 'own 30, held to the Stronger cap of 15');
  assert.ok(d.c.warnings.some(w => /judged differently/.test(w)));
  assert.ok(!('Temperature' in d.a.changes), 'never Kelvin keys on a relative file');
});

test('the model is told how relative white balance works, with measured colour evidence', () => {
  const photo = {id: 'a', baseline: {IncrementalTemperature: 0}, capabilities: {wb: true, wbMode: 'relative'},
    metrics: {subject: {method: 'face'}, faces: [{hue: 38.4, chroma: 21.2}], neutral: {a: -1.2, b: -4.5, fraction: 0.12}}};
  const p = buildPrompt({photo, scene: {id: 'S1', photos: ['a'], reference: 'a'}, policy: resolvePolicy('Natural', 'Balanced'),
    enabled: {wb: true, exposure: true, tone: false}});
  assert.match(p, /SKIN TONE \(required, every photo\)/);
  assert.match(p, /Lightroom relative steps/);
  assert.match(p, /"hueDeg":38/);
  assert.match(p, /neutralAreasCast/);
  assert.match(p, /Enabled corrections: wb, exposure\./);
});

test('exposure-and-white-balance-only never touches tone, even with Soft & airy', () => {
  const x = setup({photos: {301: heic('IMG_9101.HEIC')}, extra: {aiDefault: {...COOL,
    changes: [{setting: 'IncrementalTemperature', value: 12}, {setting: 'Shadows2012', value: 40}, {setting: 'Blacks2012', value: -20}]}}});
  try {
    const dir = x.analyze(['301'], ['--look', 'Soft & airy', '--tone', 'false']);
    const p = x.show(dir).photos[0];
    const keys = p.changes.map(c => c.key);
    assert.ok(keys.includes('IncrementalTemperature'));
    assert.ok(!keys.some(k => /Shadows|Blacks|Highlights|Whites/.test(k)), keys.join());
  } finally { x.cleanup(); }
});

test('when the look, not a correction, moves exposure, the explanation says so', () => {
  const x = setup({photos: {301: heic('IMG_9101.HEIC', {metrics: {faceLuma: null, clip: 0}})},
    extra: {aiDefault: {...COOL, skinCast: 'none', changes: [], reason: 'Exposure is correct.'}}});
  try {
    const dir = x.analyze(['301'], ['--look', 'Soft & airy', '--tone', 'false']);
    const p = x.show(dir).photos[0];
    assert.equal(p.changes[0].key, 'Exposure2012');
    assert.match(p.rationale[0], /Soft & airy look brightens subjects \(exposure was judged correct\)/);
  } finally { x.cleanup(); }
});

test('restoring relative white balance re-selects the original mode', () => {
  const base = {WhiteBalance: 'As Shot', IncrementalTemperature: 0, IncrementalTint: 0};
  const plan = restorePlan(base, {IncrementalTemperature: 10}, {...base, IncrementalTemperature: 10, WhiteBalance: 'Custom'});
  assert.deepEqual(plan.target, {WhiteBalance: 'As Shot'});
  assert.deepEqual(plan.verify, {IncrementalTemperature: 0, IncrementalTint: 0, WhiteBalance: 'As Shot'});
});

const skinPhoto = (mode, verdict, t, i) => ({id: 'p', state: 'baselined',
  capabilities: {supported: true, wb: true, wbMode: mode, exposure: true, tone: true},
  baseline: mode === 'kelvin' ? {WhiteBalance: 'As Shot', Temperature: 4950, Tint: 12, Exposure2012: 0}
    : {WhiteBalance: 'As Shot', IncrementalTemperature: 0, IncrementalTint: 0, Exposure2012: 0},
  origin: null, metrics: null,
  ai: {skip: false, confidence: 0.92, intent: 'none', mixedLighting: false, skinCast: 'none', subjectExposure: 'ok', proposed: {},
    skinTone: {verdict, temperatureShift: t, tintShift: i, note: ''}, reason: 'r'}});
const decideOne = p => decide({photos: [p], scenes: [{id: 'S1', photos: ['p'], flash: false}],
  policy: resolvePolicy('Natural', 'Balanced'), enabled: {wb: true, exposure: true, tone: false}}).p;

test('a too-cool skin verdict on RAW becomes a Kelvin change, scaled and capped by strength', () => {
  const d = decideOne(skinPhoto('kelvin', 'too-cool-and-green', 400, 5));
  assert.ok(d.changes.Temperature > 4950 && d.changes.Temperature <= 5300, String(d.changes.Temperature));
  assert.equal(d.changes.Tint, 16, '12 + 5 × 0.8');
  assert.match(d.rationale.join(' '), /Skin tone too cool and green: AI suggested \+400 K temperature, \+5 tint\./);
});

test('the same verdict on HEIC becomes a relative change', () => {
  const d = decideOne(skinPhoto('relative', 'too-cool', 10, 0));
  assert.equal(d.changes.IncrementalTemperature, 8);
  assert.ok(!('Temperature' in d.changes));
});

test('natural skin and too-small shifts are explained, never silent', () => {
  assert.match(decideOne(skinPhoto('kelvin', 'correct', 0, 0)).rationale.join(' '), /Skin tone judged natural/);
  const tiny = decideOne(skinPhoto('kelvin', 'too-warm', -30, 0));
  assert.ok(!('Temperature' in tiny.changes));
  assert.match(tiny.rationale.join(' '), /below the smallest change/);
  assert.equal(withSkinTone(skinPhoto('kelvin', 'mixed-light', 300, 0)).ai.proposed.Temperature, undefined, 'mixed light never converted');
});

test('colour science: casts map to the right slider directions', async () => {
  const {correctionForCast} = await import('../Engine/colour.mjs');
  const cool = correctionForCast({a: 0, b: -3}, 5000), warm = correctionForCast({a: 0, b: 3}, 5000);
  const magenta = correctionForCast({a: 3, b: 0}, 5000), green = correctionForCast({a: -3, b: 0}, 5000);
  assert.ok(cool.kelvin > 100 && warm.kelvin < -100, 'cool → raise Kelvin, warm → lower');
  assert.ok(magenta.tint < -5 && green.tint > 5, 'magenta → less tint, green → more');
  const boys = correctionForCast({a: 2.6, b: -1.05}, 4800);   // measured on a real photo
  assert.ok(boys.tint < -6 && boys.tint > -9 && Math.abs(boys.kelvin) < 150, JSON.stringify(boys));
});

const castPhoto = (whites, ai = {}) => ({id: 'p', state: 'baselined',
  capabilities: {supported: true, wb: true, wbMode: 'kelvin', exposure: true, tone: true},
  baseline: {WhiteBalance: 'As Shot', Temperature: 4950, Tint: 12, Exposure2012: 0},
  origin: null, metrics: {width: 960, height: 640, whites: {...whites, fraction: 0.4}, neutral: {a: 0, b: 0, fraction: 0.5}},
  ai: {skip: false, confidence: 0.92, intent: 'none', illuminant: 'daylight', mixedLighting: false, skinCast: 'none', subjectExposure: 'ok', proposed: {},
    skinTone: {verdict: 'correct', temperatureShift: 0, tintShift: 0, note: ''}, reason: 'r', ...ai}});
const decideStrong = p => decide({photos: [p], scenes: [{id: 'S1', photos: ['p'], flash: false}],
  policy: resolvePolicy('Natural', 'Stronger'), enabled: {wb: true, exposure: true, tone: false}}).p;

test('a measured magenta/cool cast is corrected even when the AI calls the skin natural', () => {
  const d = decideStrong(castPhoto({a: 3.4, b: -2.66}));
  assert.ok(d.changes.Tint <= 3, 'tint pulled from 12 toward green: ' + d.changes.Tint);
  assert.match(d.rationale.join(' '), /Skin judged natural by the AI, but white surfaces measure magenta and cool \(a\* \+3\.4, b\* -2\.7\) — corrected from the measurement\./);
});

test('deliberate warm light and tiny casts are left alone, with the reason shown', () => {
  const golden = decideStrong(castPhoto({a: 0.5, b: 4}, {illuminant: 'golden-hour'}));
  assert.ok(!('Temperature' in golden.changes) && !('Tint' in golden.changes));
  assert.match(golden.rationale.join(' '), /kept, the light colour looks deliberate/);
  const tiny = decideStrong(castPhoto({a: 0.6, b: -0.7}));
  assert.ok(!('Tint' in tiny.changes));
});

test('HEIC casts are corrected in relative steps', () => {
  const p = castPhoto({a: 3, b: -2});
  p.capabilities.wbMode = 'relative';
  p.baseline = {WhiteBalance: 'As Shot', IncrementalTemperature: 0, IncrementalTint: 0, Exposure2012: 0};
  const d = decideStrong(p);
  assert.ok(d.changes.IncrementalTint < 0, JSON.stringify(d.changes));
  assert.ok(!('Tint' in d.changes));
});

test('when the AI and the measurement agree on direction, the measurement sets the amount', () => {
  const d = decideStrong(castPhoto({a: 2.6, b: -1.05}, {skinTone: {verdict: 'too-magenta', temperatureShift: 0, tintShift: -3, note: ''}}));
  assert.ok(d.changes.Tint <= 12 - 6, 'measured ≈ −7.6, not the AI\'s −3: ' + d.changes.Tint);
  assert.match(d.rationale.join(' '), /too magenta \(AI\); white surfaces measure magenta and cool .* amount set from the measurement/);
  const disagree = decideStrong(castPhoto({a: -2.6, b: 0}, {skinTone: {verdict: 'too-magenta', temperatureShift: 0, tintShift: -3, note: ''}}));
  assert.equal(disagree.changes.Tint, 9, 'measurement says green: the AI\'s own −3 stands');
});
