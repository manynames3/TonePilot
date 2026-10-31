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
  assert.deepEqual(plan.target, {IncrementalTemperature: 0, IncrementalTint: 0, WhiteBalance: 'As Shot'});
  assert.deepEqual(plan.verify, plan.target);
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

test('when the AI calls skin natural, a cast on white surfaces is corrected only half-way, and flagged for a look', () => {
  const d = decideStrong(castPhoto({a: 3.4, b: -2.66}));
  assert.ok(d.changes.Tint >= 5 && d.changes.Tint <= 9, 'half of the measured pull toward green (12 → ~7): ' + d.changes.Tint);
  assert.match(d.rationale.join(' '), /Skin judged natural by the AI, but white surfaces measure magenta and cool \(a\* \+3\.4, b\* -2\.7\) — corrected half-way/);
  assert.ok(d.warnings.some(w => /measurement alone/.test(w)), 'the photographer is told to check');
});

test('neutral whites never create a correction, regardless of existing white balance or strength', () => {
  for (const strength of ['Subtle', 'Balanced', 'Stronger']) {
    for (const temperature of [2900, 4950, 6500]) {
      for (const tint of [-14, 0, 14]) {
        const p = castPhoto({a: 0, b: 0});
        p.baseline.Temperature = temperature; p.baseline.Tint = tint;
        const d = decide({photos: [p], scenes: [{id: 'S1', photos: ['p'], flash: false}],
          policy: resolvePolicy('Natural', strength), enabled: {wb: true, exposure: true, tone: false}}).p;
        assert.deepEqual(d.changes, {}, `${strength}, ${temperature} K, tint ${tint}`);
      }
    }
  }
});

test('mirrored white-surface casts correct tint in both directions on RAW and relative files', () => {
  for (const mode of ['kelvin', 'relative']) {
    for (const temperature of [2900, 4950, 6500]) {
      const tintKey = mode === 'kelvin' ? 'Tint' : 'IncrementalTint';
      const delta = a => {
        const p = castPhoto({a, b: 0});
        p.capabilities.wbMode = mode;
        p.baseline = mode === 'kelvin' ? {...p.baseline, Temperature: temperature}
          : {WhiteBalance: 'As Shot', IncrementalTemperature: 0, IncrementalTint: 12, Exposure2012: 0};
        const d = decideStrong(p);
        assert.ok(tintKey in d.changes, JSON.stringify(d));
        return d.changes[tintKey] - p.baseline[tintKey];
      };
      const magenta = delta(3), green = delta(-3);
      assert.ok(magenta < 0 && green > 0, `${mode}, ${temperature} K: ${magenta}, ${green}`);
      assert.ok(Math.abs(magenta + green) <= 1, 'no preferred tint direction beyond slider rounding');
    }
  }
});

test('a cast measured only on general neutral areas never changes white balance on its own', () => {
  const p = castPhoto({a: 3.4, b: -2.66});
  p.metrics.whites.fraction = 0.005;                       // no real white reference
  p.metrics.neutral = {a: 3.4, b: -2.66, fraction: 0.5};   // tinted walls, a profile's rendering…
  const d = decideStrong(p);
  assert.ok(!('Tint' in d.changes) && !('Temperature' in d.changes), JSON.stringify(d.changes));
  assert.match(d.rationale.join(' '), /neutral areas measure magenta and cool .* advisory only/);
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

test('when the AI and the measurement agree on direction, the amount is their average; when they disagree, the photo is flagged', () => {
  const d = decideStrong(castPhoto({a: 2.6, b: -1.05}, {skinTone: {verdict: 'too-magenta', temperatureShift: 0, tintShift: -3, note: ''}}));
  assert.ok(d.changes.Tint >= 6 && d.changes.Tint <= 7, 'average of measured ≈ −7.6 and the AI\'s −3 (12 → ~6.7): ' + d.changes.Tint);
  assert.match(d.rationale.join(' '), /too magenta \(AI\); white surfaces measure magenta and cool .* amount averaged with the measurement/);
  const disagree = decideStrong(castPhoto({a: -2.6, b: 0}, {skinTone: {verdict: 'too-magenta', temperatureShift: 0, tintShift: -3, note: ''}}));
  assert.equal(disagree.changes.Tint, 9, 'measurement says green: the AI\'s own −3 stands');
  assert.ok(disagree.warnings.some(w => /disagree/.test(w)), JSON.stringify(disagree.warnings));
});

test('any white-balance write also selects Custom, as Lightroom\'s own sliders do', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3')}, extra: {aiDefault: {skip: false, confidence: 0.95, scene: 's', illuminant: 'daylight',
    mixedLighting: false, backlit: false, intent: 'none', skinCast: 'magenta', subjectExposure: 'ok', changes: [],
    skinTone: {verdict: 'too-magenta', temperatureShift: 0, tintShift: -6, note: ''}, reason: 'magenta'}}});
  try {
    const dir = x.analyze(['101']);
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 0);
    const s = x.get().photos[101].settings;
    assert.deepEqual([s.whiteBalance, s.tint], ['Custom', -1], 'tint 4 − 6×0.8 rounded, mode Custom');
    assert.equal(x.get().writes[0].settings.WhiteBalance, 'Custom', 'sent in the same write');
    assert.equal(x.show(dir).photos[0].state, 'applied');
    assert.ok(!x.show(dir).photos[0].changes.some(c => c.key === 'WhiteBalance'), 'mode is not shown as a slider row');
    assert.equal(x.run(['--mode', 'restore', '--session', dir, '--confirm']).status, 0);
    const r = x.get().photos[101].settings;
    assert.deepEqual([r.whiteBalance, r.tint, r.temperature], ['As Shot', 4, 5200]);
    assert.equal(x.show(dir).status, 'restored');
  } finally { x.cleanup(); }
});

test('a half-way change made on the measurement alone stays on that photo; neighbours are not synced to it', () => {
  const a = {...castPhoto({a: 3.4, b: -2.66}), id: 'a'};
  const b = {...castPhoto({a: 0, b: 0}), id: 'b'}, c = {...castPhoto({a: 0, b: 0}), id: 'c'};
  b.metrics = {...b.metrics, whites: {a: 0, b: 0, fraction: 0.005}, neutral: {a: 3.4, b: -2.66, fraction: 0.5}};
  const d = decide({photos: [a, b, c], scenes: [{id: 'S1', photos: ['a', 'b', 'c'], flash: false}],
    policy: resolvePolicy('Natural', 'Stronger'), enabled: {wb: true, exposure: true, tone: false}});
  assert.ok('Tint' in d.a.changes, 'the measured photo is corrected half-way');
  assert.ok(!('Tint' in d.b.changes) && !('Tint' in d.c.changes), JSON.stringify([d.b.changes, d.c.changes]));
});

test('the disagree warning ignores negligible measured components and names the real source', () => {
  // Model: cooler skin (raise Kelvin) and less magenta. Measurement: clearly magenta; its temperature component
  // (under 3 mired here) is too small to agree or disagree with anything.
  const d = decideStrong(castPhoto({a: 3.0, b: -2.1}, {skinTone: {verdict: 'too-cool-and-magenta', temperatureShift: 300, tintShift: -3, note: ''}}));   // +300 K vs a −50 K (2 mired) measured component
  assert.ok(!d.warnings.some(w => /disagree/.test(w)), JSON.stringify(d.warnings));
  const p = castPhoto({a: -3, b: 0}, {skinTone: {verdict: 'too-magenta', temperatureShift: 0, tintShift: -3, note: ''}});
  p.metrics.whites.fraction = 0.005; p.metrics.neutral = {a: -3, b: 0, fraction: 0.5};
  assert.ok(decideStrong(p).warnings.some(w => /measured neutral areas disagree/.test(w)));
});

test('a correction that hits the strength limit stays inside it after rounding (tungsten-range photos were being blocked)', () => {
  const {mired} = {mired: k => 1e6 / k};
  for (const base of [2900, 3100, 3600, 4950, 6500]) {
    for (const verdict of [['too-cool', 600], ['too-warm', -600]]) {
      const p = skinPhoto('kelvin', verdict[0], verdict[1], 0);
      p.baseline.Temperature = base; p.origin = {...p.baseline};
      const d = decideOne(p);
      assert.equal(d.status, 'proposed', base + ' K ' + verdict[0] + ': ' + d.reason);
      assert.ok(Math.abs(mired(d.changes.Temperature) - mired(base)) <= 20 + 1e-6, base + ' K → ' + d.changes.Temperature);
    }
  }
});

test('skin is the reference: a cooler or mixed background never switches white balance off', () => {
  const p = skinPhoto('kelvin', 'too-warm-and-magenta', -200, -3);
  p.ai.mixedLighting = true;
  const d = decideOne(p);
  assert.equal(d.status, 'proposed', d.reason);
  assert.ok(d.changes.Temperature < 4950 && d.changes.Tint < 12, JSON.stringify(d.changes));
  assert.ok(d.warnings.some(w => /background/i.test(w)), JSON.stringify(d.warnings));
});

const lowConf = (whites, ai = {}) => castPhoto(whites, {confidence: 0.78, ...ai});
const decideBalanced = p => decide({photos: [p], scenes: [{id: 'S1', photos: ['p'], flash: false}],
  policy: resolvePolicy('Natural', 'Balanced'), enabled: {wb: true, exposure: true, tone: false}}).p;

test('below the confidence bar, white balance goes ahead only when the measurement independently agrees', () => {
  const skin = {skinTone: {verdict: 'too-cool-and-magenta', temperatureShift: 150, tintShift: -3, note: ''}};
  const agree = decideBalanced(lowConf({a: 3.1, b: -2.5}, skin));
  assert.equal(agree.status, 'proposed', agree.reason);
  assert.match(agree.rationale.join(' '), /80%|78%/, 'the confidence and why it was accepted are shown');
  const disagree = decideBalanced(lowConf({a: -3, b: 0}, skin));
  assert.equal(disagree.status, 'flagged');
  assert.match(disagree.reason, /measurements? (do|does)n.t confirm|not confirmed/i);
  const nothing = lowConf({a: 0, b: 0}, skin); nothing.metrics = null;
  assert.equal(decideBalanced(nothing).status, 'flagged', 'no measurement, no corroboration');
  const tooLow = decideBalanced(lowConf({a: 3.1, b: -2.5}, {confidence: 0.62, ...skin}));
  assert.equal(tooLow.status, 'flagged', 'a floor applies even with agreement');
});

test('each photo\'s own skin verdict wins over the scene: a frame whose temperature is fine is not dragged to its neighbours\' correction', () => {
  const fine = {...skinPhoto('kelvin', 'too-magenta', 0, -4), id: 'a'};   // temperature fine, only magenta
  const warm = {...skinPhoto('kelvin', 'too-warm-and-magenta', -250, -3), id: 'b'};
  const warm2 = {...skinPhoto('kelvin', 'too-warm-and-magenta', -250, -3), id: 'c'};
  const d = decide({photos: [fine, warm, warm2], scenes: [{id: 'S1', photos: ['a', 'b', 'c'], flash: false}],
    policy: resolvePolicy('Natural', 'Balanced'), enabled: {wb: true, exposure: true, tone: false}});
  assert.ok(!('Temperature' in d.a.changes), 'temperature left alone: ' + JSON.stringify(d.a.changes));
  assert.ok(d.a.changes.Tint < 12, 'its own tint correction stands');
  assert.ok(d.b.changes.Temperature < 4950 && d.c.changes.Temperature < 4950);
  assert.match(d.b.rationale.join(' '), /set for the skin/);
});

const sceneOf = (...ps) => [{id: 'S1', photos: ps.map(p => p.id), flash: false}];
const balanced = (ps, enabled = {wb: true, exposure: true, tone: false}) =>
  decide({photos: ps, scenes: sceneOf(...ps), policy: resolvePolicy('Natural', 'Balanced'), enabled});
const coolMagenta = {verdict: 'too-cool-and-magenta', temperatureShift: 150, tintShift: -3, note: ''};

test('mixed light plus weak or deliberate evidence is not synced to the scene; only skin evidence goes ahead', () => {
  const advisory = {...castPhoto({a: 0, b: 0}), id: 'a'};
  advisory.ai.mixedLighting = true;
  advisory.metrics = {...advisory.metrics, whites: {a: 0, b: 0, fraction: 0.005}, neutral: {a: 3.4, b: -2.66, fraction: 0.5}};
  const golden = {...castPhoto({a: 0.5, b: 4}, {illuminant: 'golden-hour'}), id: 'g'};
  const b = {...skinPhoto('kelvin', 'too-warm-and-magenta', -250, -3), id: 'b'}, c = {...skinPhoto('kelvin', 'too-warm-and-magenta', -250, -3), id: 'c'};
  const d = balanced([advisory, golden, b, c]);
  assert.ok(!('Temperature' in d.a.changes) && !('Tint' in d.a.changes), 'advisory + mixed light: ' + JSON.stringify(d.a.changes));
  assert.ok(!('Temperature' in d.g.changes), 'deliberate golden light stays: ' + JSON.stringify(d.g.changes));
  assert.ok(d.b.changes.Temperature < 4950, 'skin-driven frames still corrected');
});

test('below the confidence bar, only the axes the measurement confirmed are applied', () => {
  // AI: cooler skin (+200 K) and magenta (−9 tint). Measurement: clearly cool, almost no magenta (tint < 2).
  const p = lowConf({a: 0.1, b: -3}, {skinTone: {verdict: 'too-cool-and-magenta', temperatureShift: 200, tintShift: -9, note: ''}, confidence: 0.75});
  const d = decideBalanced(p);
  assert.equal(d.status, 'proposed', d.reason);
  assert.ok(d.changes.Temperature > 4950, 'temperature confirmed: ' + JSON.stringify(d.changes));
  assert.ok(!('Tint' in d.changes), 'tint was not confirmed by the measurement: ' + JSON.stringify(d.changes));
});

test('a cast on general neutral areas never confirms a low-confidence verdict', () => {
  const p = lowConf({a: 3.1, b: -2.5}, {skinTone: coolMagenta, confidence: 0.75});
  p.metrics.whites.fraction = 0.005; p.metrics.neutral = {a: 3.1, b: -2.5, fraction: 0.5};
  assert.equal(decideBalanced(p).status, 'flagged');
});

test('below the bar, nothing but the confirmed white-balance moves: no exposure, no tone', () => {
  const p = lowConf({a: 3.1, b: -2.5}, {skinTone: coolMagenta, confidence: 0.75, subjectExposure: 'under', proposed: {Exposure2012: 0.6, Shadows2012: 40}});
  const d = decide({photos: [p], scenes: sceneOf(p), policy: resolvePolicy('Natural', 'Balanced'), enabled: {wb: true, exposure: true, tone: true}}).p;
  assert.equal(d.status, 'proposed', d.reason);
  assert.ok(('Temperature' in d.changes || 'Tint' in d.changes) && !('Exposure2012' in d.changes) && !('Shadows2012' in d.changes), JSON.stringify(d.changes));
});

test('a below-the-bar photo is a consumer of its scene, never an anchor for the others', () => {
  const a = {...lowConf({a: 3.1, b: -2.5}, {skinTone: {verdict: 'too-cool-and-magenta', temperatureShift: 400, tintShift: -3, note: ''}, confidence: 0.75}), id: 'a'};
  const b = {...castPhoto({a: 0, b: 0}), id: 'b'}, c = {...castPhoto({a: 0, b: 0}), id: 'c'};   // confident, skin natural, no cast
  const d = balanced([a, b, c]);
  // The magenta-heavy cast has almost no temperature component, so only tint is confirmed and applied;
  // the model's +400 K never becomes the scene's target for the confident frames.
  assert.ok('Tint' in d.a.changes && !('Temperature' in d.a.changes), JSON.stringify(d.a.changes));
  assert.ok(!('Temperature' in d.b.changes) && !('Temperature' in d.c.changes), 'its proposal did not become the scene target');
});

test('JPEG/HEIC: each photo keeps its own skin correction instead of being blended toward the scene', () => {
  const a = {...skinPhoto('relative', 'too-magenta', 0, -9), id: 'a'}, b = {...skinPhoto('relative', 'too-magenta', 0, -3), id: 'b'};
  const d = balanced([a, b]);
  assert.equal(d.a.changes.IncrementalTint, -7, JSON.stringify(d.a.changes));   // 80% of −9, not pulled toward −6
  assert.equal(d.b.changes.IncrementalTint, -2, JSON.stringify(d.b.changes));
});

test('white-cast result checks ignore missing, tiny, changed-area or improving references', async () => {
  const {whiteCastRegression} = await import('../Engine/colour.mjs');
  const m = (a, fraction = 0.1) => ({width: 640, whites: {a, b: 0, fraction}});
  assert.equal(whiteCastRegression(m(2), m(5)), true);
  assert.equal(whiteCastRegression(m(2), m(0.5)), false);
  assert.equal(whiteCastRegression(m(2), null), false);
  assert.equal(whiteCastRegression(m(2), m(5, 0.005)), false);
  assert.equal(whiteCastRegression(m(2), m(5, 0.4)), false);
  assert.equal(whiteCastRegression(m(2), {...m(5), width: 320}), false);
});
