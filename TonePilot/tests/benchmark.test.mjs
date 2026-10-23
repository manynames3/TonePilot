// The benchmark tools must refuse to produce claims the data cannot support.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {evaluate, wilson, mcnemar, calibration} from '../Benchmarks/evaluate.mjs';
import {repeatability} from '../Benchmarks/repeatability.mjs';

function gallery(n, {tpAccept = 0.9, baseAccept = 0.6, tpMin = 1, baseMin = 2, reg = 0, skins = ['I-II', 'III-IV', 'V-VI']} = {}) {
  return {blinded: true, photos: Array.from({length: n}, (_, i) => ({
    id: 'p' + i, confidence: 0.6 + 0.4 * (i % 10) / 10,
    category: {lighting: i % 2 ? 'tungsten' : 'daylight', skin: skins[i % skins.length]},
    scores: {
      tonepilot: {accepted: (i % 100) < tpAccept * 100, majorRegression: (i % 100) < reg * 100, reviewMinutes: tpMin},
      'lightroom-auto': {accepted: (i % 100) < baseAccept * 100, majorRegression: false, reviewMinutes: baseMin}
    }}))};
}

test('wilson intervals are honest at small samples', () => {
  const [lo, hi] = wilson(5, 5);
  assert.ok(lo < 0.6 && hi === 1, '5/5 does not prove a 100% rate');
  const [lo2] = wilson(90, 100);
  assert.ok(lo2 > 0.82 && lo2 < 0.85);
});

test('blind scoring is mandatory and every method must be fully scored', () => {
  assert.throws(() => evaluate({blinded: false, photos: [{}]}), /blind/);
  const g = gallery(10); delete g.photos[3].scores['lightroom-auto'].reviewMinutes;
  assert.throws(() => evaluate(g), /Incomplete/);
});

test('a small sample is never "validated", even with perfect scores', () => {
  const r = evaluate(gallery(40, {tpAccept: 1, baseAccept: 0.2}));
  assert.equal(r.gates.enoughPhotos, false);
  assert.equal(r.validated, false);
});

test('validation requires interval bounds, a paired advantage and time saved', () => {
  const strong = evaluate(gallery(300, {tpAccept: 0.93, baseAccept: 0.6}));
  assert.equal(strong.validated, true, JSON.stringify(strong.gates));
  assert.ok(strong.comparisons[0].mcnemar.p < 0.001);
  const borderline = evaluate(gallery(120, {tpAccept: 0.86, baseAccept: 0.6}));
  assert.equal(borderline.gates.acceptanceAtLeast85, true);
  assert.equal(borderline.gates.acceptanceLowerBoundAtLeast85, false, '86% of 120 is not proof of ≥85%');
  assert.equal(borderline.validated, false);
  const slow = evaluate(gallery(300, {tpAccept: 0.93, tpMin: 1.5}));
  assert.equal(slow.gates.timeSavedAtLeast40AgainstEveryBaseline, false);
});

test('results are broken down by skin group and lighting, and the weakest group is named', () => {
  const r = evaluate(gallery(150));
  assert.deepEqual(Object.keys(r.bySkinGroup).sort(), ['I-II', 'III-IV', 'V-VI']);
  assert.ok(r.weakestSkinGroup && r.weakestSkinGroup.photos >= 10);
  assert.deepEqual(Object.keys(r.byLighting).sort(), ['daylight', 'tungsten']);
});

test('calibration turns self-reported confidence into an evidence-based threshold', () => {
  const rows = Array.from({length: 200}, (_, i) => {
    const confidence = 0.5 + (i % 50) / 100;
    return {id: String(i), confidence, scores: {tonepilot: {accepted: confidence >= 0.8 || i % 3 === 0, majorRegression: false, reviewMinutes: 1}}};
  });
  const c = calibration(rows);
  assert.equal(c.available, true);
  assert.ok(c.recommendedThreshold.confidence >= 0.78, JSON.stringify(c.recommendedThreshold));
  assert.ok(c.expectedCalibrationError >= 0);
  assert.equal(calibration(rows.slice(0, 5)).available, false);
  assert.deepEqual(mcnemar([{scores: {a: {accepted: true}, b: {accepted: false}}}], 'a', 'b'), {onlyA: 1, onlyB: 0, p: 1});
});

test('repeatability compares decisions across identical runs', () => {
  const mk = (state, ev) => ({order: ['1'], photos: {1: {id: '1', filename: 'a', state, baseline: {Exposure2012: 0}, changes: ev ? {Exposure2012: ev} : {}, ai: {subjectExposure: 'under', confidence: 0.9}}}});
  const same = repeatability([mk('proposed', 0.3), mk('proposed', 0.35)]);
  assert.equal(same.decisionAgreement, 1); assert.equal(same.settingAgreement, 1);
  const diff = repeatability([mk('proposed', 0.3), mk('skipped', 0)]);
  assert.equal(diff.decisionAgreement, 0);
});

test('vs-photographer: records the photographer\'s finished values read-only, then scores TonePilot\'s plan against them', async () => {
  const {spawnSync} = await import('node:child_process');
  const {join} = await import('node:path');
  const {setup, rawPhoto} = await import('./helpers.mjs');
  const script = new URL('../Benchmarks/vs-photographer.mjs', import.meta.url).pathname;
  const x = setup({photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3')}});
  try {
    // Main catalog: the photographer brightened A by 0.5 EV and pushed its tint to 10; B was left alone.
    x.set(s => { Object.assign(s.photos[101].settings, {exposure: 0.5, tint: 10}); });
    const ref = join(x.temp, 'reference.json');
    const c = spawnSync(process.execPath, [script, 'capture', '--out', ref], {env: x.env, encoding: 'utf8'});
    assert.equal(c.status, 0, c.stderr);
    assert.equal(x.get().writes.length, 0, 'capture is read-only');
    // Test catalog: fresh, unedited copies of the same files; TonePilot proposes +0.24 EV.
    x.set(s => { Object.assign(s.photos[101].settings, {exposure: 0, tint: 4}); });
    const dir = x.analyze(['101', '102']);
    const r = spawnSync(process.execPath, [script, 'compare', ref, dir], {env: x.env, encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.matchedPhotos, 2);
    const ev = report.bySetting.find(s => s.setting === 'Exposure2012'), tint = report.bySetting.find(s => s.setting === 'Tint');
    assert.deepEqual([ev.photographerChanged, ev.closer, ev.further, ev.wrongDirection], [1, 1, 0, 0]);
    assert.equal(ev.medianDistanceUnedited, 0.5);
    assert.equal(ev.medianDistanceTonePilot, 0.26, 'Balanced applies 80% of +0.3 EV: 0.24, so 0.26 EV short of the photographer');
    assert.equal(ev.changedWhenPhotographerDidNot, 1, 'B was brightened although the photographer left it alone');
    assert.deepEqual([tint.photographerChanged, tint.medianDistanceUnedited, tint.closer], [1, 6, 0]);
  } finally { x.cleanup(); }
});
