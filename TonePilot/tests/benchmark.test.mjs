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

test('a skin group that is materially worse, or too small to assess, blocks validation', () => {
  // 450 photos of one group all accepted, 50 of another all rejected: 90% overall clears every other gate.
  const g = gallery(500, {tpAccept: 1});
  g.photos.forEach((p, i) => { p.category.skin = i < 450 ? 'I-II' : 'V-VI'; p.scores.tonepilot.accepted = i < 450; });
  const bad = evaluate(g);
  assert.ok(bad.methods.tonepilot.acceptanceCI[0] >= 0.85);
  assert.equal(bad.bySkinGroup['V-VI'].assessment, 'below-floor');
  assert.equal(bad.gates.everySkinGroupAssessedAndAtLeast75, false);
  assert.equal(bad.validated, false, 'a 0% skin group must never be hidden by a strong average');
  // The same group fully accepted but with only 10 photos: insufficient, not a silent pass.
  const small = gallery(460, {tpAccept: 1});
  small.photos.forEach((p, i) => { p.category.skin = i < 450 ? 'I-II' : 'V-VI'; });
  const r = evaluate(small);
  assert.equal(r.bySkinGroup['V-VI'].assessment, 'insufficient');
  assert.equal(r.validated, false);
  // Unrecorded skin groups, or a single group, cannot show that no group is worse.
  assert.equal(evaluate(gallery(300, {tpAccept: 0.93, skins: ['III-IV']})).gates.everySkinGroupAssessedAndAtLeast75, false);
  const none = gallery(300, {tpAccept: 0.93}); none.photos.forEach(p => delete p.category.skin);
  assert.equal(evaluate(none).bySkinGroup.unspecified.assessment, 'insufficient');
});

test('duplicate photo ids and photos missing a method\'s score are rejected', () => {
  const dup = gallery(120); dup.photos[5].id = dup.photos[4].id;
  assert.throws(() => evaluate(dup), /Duplicate photo id p4/);
  const missing = gallery(120); delete missing.photos[7].scores['lightroom-auto'];
  assert.throws(() => evaluate(missing), /Incomplete independent scoring for lightroom-auto on p7/);
  const extra = gallery(120); extra.photos[0].scores.aftershoot = extra.photos[0].scores.tonepilot;
  assert.throws(() => evaluate(extra), /aftershoot on p1/);
});

test('zero regressions prove < 2% only from 189 photos (Wilson upper bound)', () => {
  assert.ok(wilson(0, 189)[1] < 0.02 && wilson(0, 188)[1] >= 0.02);
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

test('owner-review: every photo is listed, ratings come from stdin, resume keeps answers, report is labelled', async () => {
  const {spawnSync} = await import('node:child_process');
  const {mkdtempSync, rmSync, statSync, readFileSync} = await import('node:fs');
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const {Journal} = await import('../Engine/journal.mjs');
  const script = new URL('../Benchmarks/owner-review.mjs', import.meta.url).pathname;
  const temp = mkdtempSync(join(tmpdir(), 'tonepilot-review-'));
  try {
    const dir = join(temp, 'session-1'), out = join(temp, 'review.json');
    const j = Journal.create(dir, 'session-created', {id: 'S1', photos: ['A', 'B', 'C', 'D'].map((f, i) => ({id: String(i + 1), filename: f + '.CR3'}))});
    for (const id of ['1', '2', '3']) j.append('photo-baseline', {photo: id, baseline: {Exposure2012: 0, Temperature: 5000}});
    j.append('photo-proposed', {photo: '1', decision: {status: 'proposed', changes: {Exposure2012: 0.3, Temperature: 5400}}});
    j.append('photo-proposed', {photo: '2', decision: {status: 'skipped', changes: {}, reason: 'Already well exposed'}});
    j.append('photo-proposed', {photo: '3', decision: {status: 'flagged', changes: {}, reason: 'Mixed light'}});
    j.append('photo-unsupported', {photo: '4', reason: 'Video'});
    j.close();
    const run = (args, input) => spawnSync(process.execPath, [script, ...args], {input, encoding: 'utf8'});

    let r = run(['start', dir, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    let review = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(review.photos.map(p => p.tonepilot.state), ['proposed', 'skipped', 'flagged', 'unsupported'], 'unchanged and flagged photos are included');
    assert.deepEqual(review.photos[0].tonepilot.changes.map(c => [c.setting, c.from, c.to]).sort(), [['Exposure', 0, 0.3], ['Temperature', 5000, 5400]]);

    // Photo A fully (an invalid answer is asked again), then input ends part-way through B.
    r = run(['rate', out], 'better\nmaybe\nw\ntoo cool on skin\ns\n');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /A\.CR3 — Edit proposed[\s\S]*Exposure: 0 → 0\.3/);
    assert.match(r.stdout, /Please answer/);
    review = JSON.parse(readFileSync(out, 'utf8'));
    const a = review.photos[0].rating;
    assert.deepEqual([a.exposure, a.whiteBalance, a.note], ['better', 'worse', 'too cool on skin']);
    assert.equal(review.photos[1].rating.exposure, 'same', 'saved after every answer');

    // Resuming start keeps answers; rating continues with B's white balance.
    assert.equal(run(['start', dir, '--out', out]).status, 0);
    r = run(['rate', out], 'n\n\nworse\nna\nshould have brightened\nna\nna\n\n');
    assert.match(r.stdout, /All 4 photos rated/);
    review = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(review.photos[0].rating.note, 'too cool on skin');
    assert.deepEqual(review.photos.map(p => [p.rating.exposure, p.rating.whiteBalance]),
      [['better', 'worse'], ['same', 'na'], ['worse', 'na'], ['na', 'na']]);

    r = run(['report', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OWNER PILOT — NOT VALIDATED/);
    assert.match(r.stdout, /Exposure: +better 1, same 1, worse 1, na 1, unrated 0/);
    assert.match(r.stdout, /White balance: better 0, same 0, worse 1, na 3, unrated 0/);
    assert.match(r.stdout, /A\.CR3 \[Edit proposed\] white balance — too cool on skin/);
    assert.match(r.stdout, /C\.CR3 \[Needs your review\] exposure — should have brightened/);
    assert.notEqual(run(['start', join(temp, 'missing'), '--out', out]).status, 0);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});
