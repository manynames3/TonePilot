// Real engine, private mock Lightroom and model; no real catalog or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {setup, rawPhoto} from './helpers.mjs';
const calls = x => fs.readFileSync(x.state + '.calls', 'utf8').trim().split('\n').length;

test('analyzing unchanged photos again reuses the assessment and reproduces the plan', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3')}});
  try {
    const first = x.analyze(['101']), again = x.analyze(['101']);
    assert.equal(calls(x), 1, 'the same input must not get a second model judgment');
    const a = x.show(first), b = x.show(again);
    assert.deepEqual(b.photos.map(p => p.changes), a.photos.map(p => p.changes));
    assert.equal(x.journal(again).find(r => r.type === 'photo-assessed').stats.reusedFrom, a.id);
    assert.equal(x.get().writes.length, 0);
  } finally { x.cleanup(); }
});

test('settings, measurements, scene membership and model changes each require a new assessment', () => {
  for (const change of ['settings', 'measurements', 'scene', 'model', 'effort', 'look']) {
    const x = setup({photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3')}, selected: ['101']});
    try {
      x.analyze(['101']);
      if (change === 'settings') x.set(s => { s.photos[101].settings.exposure = 0.2; });
      if (change === 'measurements') x.set(s => { s.photos[101].metrics.faceLuma = 0.08; });
      if (change === 'scene') x.set(s => { s.selected = ['101', '102']; });
      const env = change === 'model' ? {TONEPILOT_AI_MODEL: 'different-model'} : change === 'effort' ? {TONEPILOT_AI_EFFORT: 'medium'} : {};
      const ids = change === 'scene' ? ['101', '102'] : ['101'];
      const r = x.run(['--mode', 'analyze', '--ids', JSON.stringify(ids), ...(change === 'look' ? ['--look', 'Soft & airy'] : [])], env);
      assert.equal(r.status, 0, JSON.stringify(r.error));
      assert.equal(calls(x), change === 'scene' ? 3 : 2, change);
      assert.ok(!x.journal(r.complete.dir).some(r => r.stats?.reusedFrom), change);
    } finally { x.cleanup(); }
  }
});

test('fresh assessment is explicit; discarded sessions are never reused', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3')}});
  try {
    const first = x.analyze(['101']);
    assert.equal(x.run(['--mode', 'discard', '--session', first, '--confirm']).status, 0);
    x.analyze(['101']);
    assert.equal(calls(x), 2, 'discarded judgment is not a source');
    x.analyze(['101'], ['--fresh-assessment']);
    assert.equal(calls(x), 3, 'fresh means a real model call');
  } finally { x.cleanup(); }
});

test('choosing a reference replans read-only, keeps that frame and refuses changes after apply starts', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3', {shutterSpeed: '1/500 sec', metrics: {faceLuma: 0.06, clip: 0, clipAtEV: Array(20).fill(0)}})}});
  try {
    const dir = x.analyze(['101', '102']);
    const r = x.run(['--mode', 'reference', '--session', dir, '--id', '101']);
    assert.equal(r.status, 0, JSON.stringify(r.error));
    const v = x.show(dir);
    assert.equal(v.scenes[0].referenceApproved, true);
    assert.equal(v.scenes[0].reference, '101');
    assert.deepEqual(v.photos[0].changes, []);
    assert.equal(x.get().writes.length, 0);
    assert.equal(x.run(['--mode', 'reference', '--session', dir, '--id', '999']).status, 1);
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm', '--only', '["102"]']).status, 0);
    assert.equal(x.run(['--mode', 'reference', '--session', dir, '--id', '101']).status, 1, 'even an untouched frame cannot replan after applying');
  } finally { x.cleanup(); }
});

test('an interrupted reference revision cannot be applied and resumes the revised plan', async () => {
  const {Journal} = await import('../Engine/journal.mjs');
  const x = setup({photos: {101: rawPhoto('A.CR3')}});
  try {
    const dir = x.analyze(['101']);
    const j = Journal.open(dir);
    j.append('plan-revision-started');
    j.append('scene-reference', {scene: 'S1', reference: '101', approved: true});
    assert.equal(x.show(dir).actions.apply, false);
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 1);
    assert.equal(x.run(['--mode', 'analyze', '--resume', dir]).status, 0);
    assert.deepEqual(x.show(dir).photos[0].changes, []);
    assert.equal(x.get().writes.length, 0);
  } finally { x.cleanup(); }
});

test('after-edit checks flag a larger measured white cast without claiming that the write failed', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3', {metrics: {faceLuma: 0.12, clip: 0, atTint: 4,
    whites: {a: 2, b: 0, fraction: 0.15}, whitesAfter: {a: 5, b: 0, fraction: 0.15}}})},
    extra: {aiDefault: {skip: false, confidence: 0.95, scene: 's', illuminant: 'daylight', mixedLighting: false,
      intent: 'none', subjectExposure: 'ok', changes: [], skinTone: {verdict: 'too-magenta', temperatureShift: 0, tintShift: -4, note: ''}, reason: 'cast'}}});
  try {
    const dir = x.analyze(['101']);
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 0);
    const p = x.show(dir).photos[0];
    assert.equal(p.write.outcome, 'verified');
    assert.equal(p.state, 'applied');
    assert.ok(p.warnings.some(w => /white.balance|white areas/i.test(w)), JSON.stringify(p.warnings));
    assert.equal(p.reviewRecommended, true);
    assert.equal(x.run(['--mode', 'restore', '--session', dir, '--confirm']).status, 0);
    assert.equal(x.show(dir).photos[0].reviewRecommended, false, 'a restored result no longer needs review of the undone edit');
  } finally { x.cleanup(); }
});

test('a photographer edit to a reference is detected before choosing it and again before any dependent write', () => {
  for (const when of ['before-reference', 'before-apply']) {
    const x = setup({photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3', {shutterSpeed: '1/500 sec', metrics: {faceLuma: 0.06, clip: 0, clipAtEV: Array(20).fill(0)}})}});
    try {
      const dir = x.analyze(['101', '102']);
      if (when === 'before-apply') assert.equal(x.run(['--mode', 'reference', '--session', dir, '--id', '101']).status, 0);
      x.set(s => { s.photos[101].settings.exposure = 0.3; });
      const r = when === 'before-reference' ? x.run(['--mode', 'reference', '--session', dir, '--id', '101'])
        : x.run(['--mode', 'apply', '--session', dir, '--confirm', '--only', '["102"]']);
      assert.equal(r.status, 1, when);
      assert.match(r.error.message, /reference.*changed|reference.*edited/i);
      assert.equal(x.get().writes.length, 0);
    } finally { x.cleanup(); }
  }
});

test('an approved reference follows identical scene inputs into the next pass, and clearing it persists', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3')}});
  try {
    const dir = x.analyze(['101', '102']);
    x.analyze(['101', '102']);   // a newer automatic pass must not hide an explicit choice in the older pass
    assert.equal(x.run(['--mode', 'reference', '--session', dir, '--id', '102']).status, 0);
    const next = x.analyze(['101', '102']);
    assert.equal(x.show(next).scenes[0].reference, '102');
    assert.equal(x.show(next).scenes[0].referenceApproved, true);
    assert.equal(x.run(['--mode', 'reference', '--session', dir, '--scene', 'S1', '--clear-reference']).status, 0);
    const automatic = x.analyze(['101', '102']);
    assert.ok(!x.show(automatic).scenes[0].referenceApproved);
  } finally { x.cleanup(); }
});

test('model repeatability reports reject reused assessments rather than reporting artificial agreement', async () => {
  const {loadSession} = await import('../Engine/session.mjs');
  const {repeatability} = await import('../Benchmarks/repeatability.mjs');
  const x = setup({photos: {101: rawPhoto('A.CR3')}});
  try {
    const a = x.analyze(['101']), b = x.analyze(['101']);
    assert.throws(() => repeatability([loadSession(a), loadSession(b)]), /fresh-assessment|reused/i);
  } finally { x.cleanup(); }
});

test('an unavailable after-edit measurement is shown as a review warning while setting verification remains intact', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3', {metrics: {faceLuma: 0.12, clip: 0, failAfterWrite: true}})}});
  try {
    const dir = x.analyze(['101']);
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 0);
    const p = x.show(dir).photos[0];
    assert.equal(p.write.outcome, 'verified');
    assert.equal(p.reviewRecommended, true);
    assert.ok(p.warnings.some(w => /visual check.*unavailable|could not.*measur/i.test(w)), JSON.stringify(p.warnings));
  } finally { x.cleanup(); }
});

// ---- Skin-first consistency within a scene ----
{
  const {decide} = await import('../Engine/harmonize.mjs');
  const {resolvePolicy, mired} = await import('../Engine/policy.mjs');
  const {sceneConsistency} = await import('../Engine/consistency.mjs');
  const caps = {supported: true, wb: true, wbMode: 'kelvin', exposure: true, tone: true};
  let n = 0;
  const frame = ({face = 0.12, temp = 5000, tint = 10, skin = null, ai = {}} = {}) => {
    const id = String(++n), b = {WhiteBalance: 'As Shot', Temperature: temp, Tint: tint, Exposure2012: 0};
    return {id, filename: 'F' + id, state: 'baselined', baseline: b, origin: {...b}, capabilities: caps,
      identity: {captureTime: '2026-06-01 15:00:' + String(n).padStart(2, '0')},
      exif: {cameraModel: 'R5', flash: 'Did not fire', aperture: 'f / 2.8', shutterSpeed: '1/250 sec', isoSpeedRating: 'ISO 400'},
      metrics: {width: 1024, height: 683, subject: {method: 'face', luma: face, area: 0.05}, faces: [{luma: face, hue: 50, lab: [50, 18, 20], area: 0.05}],
        clip: {channel: 0.001}, clipAtEV: Array(20).fill(0.001), grid: Array(48).fill(50)},
      ai: {skip: false, confidence: 0.92, scene: 's', illuminant: 'window', mixedLighting: false, backlit: false, intent: 'none', skinCast: 'none',
        subjectExposure: 'ok', proposed: {}, reason: 'r', skinTone: skin || {verdict: 'correct', temperatureShift: 0, tintShift: 0, note: ''}, ...ai}};
  };
  const plan = (ps, strength = 'Stronger') => {
    const scenes = [{id: 'S1', photos: ps.map(p => p.id), reference: ps[0].id, flash: false}];
    const d = decide({photos: ps, scenes, policy: resolvePolicy('Natural', strength), enabled: {wb: true, exposure: true, tone: false}});
    return {d, after: ps.map(p => ({...p, changes: d[p.id].changes}))};
  };
  const evOf = (d, p) => (d[p.id].changes.Exposure2012 ?? 0);

  test('faces in one scene are brought within a band of the scene\'s level when the model also saw them as off; frames inside it are left alone', () => {
    n = 0;
    const ps = [frame({face: 0.20, ai: {subjectExposure: 'over'}}), frame({face: 0.12}), frame({face: 0.125}), frame({face: 0.115}), frame({face: 0.07, ai: {subjectExposure: 'under'}})];
    const {d, after} = plan(ps);
    assert.ok(evOf(d, ps[0]) < -0.4, 'the bright frame comes down: ' + evOf(d, ps[0]));
    assert.ok(evOf(d, ps[4]) > 0.4, 'the dark frame comes up: ' + evOf(d, ps[4]));
    for (const p of ps.slice(1, 4)) assert.equal(evOf(d, p), 0, 'inside the band: untouched');
    const c = sceneConsistency(after);
    assert.ok(c.before.brightnessEV > 1.4 && c.planned.brightnessEV <= 0.56, JSON.stringify(c));
    assert.match(d[ps[4].id].rationale.join(' '), /within ±0\.25 EV of this scene/);
  });

  test('a face the model judged fine may be a different complexion: it moves only half-way, by at most 0.3 EV, and never against the model', () => {
    n = 0;
    const ps = [frame({face: 0.12}), frame({face: 0.125}), frame({face: 0.115}), frame({face: 0.05}), frame({face: 0.26, ai: {subjectExposure: 'under'}})];
    const {d} = plan(ps);
    assert.ok(evOf(d, ps[3]) > 0.2 && evOf(d, ps[3]) <= 0.3, 'limited: ' + evOf(d, ps[3]));
    assert.equal(evOf(d, ps[4]), 0, 'bright face, but the model saw it as under-exposed: left for its own judgment');
  });

  test('frames in the same light share one white-balance correction: per-photo model noise is averaged out', () => {
    n = 0;
    const skin = (t, i) => ({verdict: 'too-cool-and-magenta', temperatureShift: t, tintShift: i, note: ''});
    const ps = [frame({skin: skin(150, -3)}), frame({skin: skin(250, -5)}), frame({skin: skin(200, -4)}), frame({skin: skin(100, -4)})];
    const {d} = plan(ps);
    const temps = new Set(ps.map(p => d[p.id].changes.Temperature)), tints = new Set(ps.map(p => d[p.id].changes.Tint));
    assert.equal(temps.size, 1, 'one temperature for the scene: ' + [...temps]);
    assert.equal(tints.size, 1, 'one tint for the scene: ' + [...tints]);
    assert.match(d[ps[0].id].rationale.join(' '), /shared by the 4 frames in the same light/);
  });

  test('a frame whose skin verdict clearly differs from its scene keeps its own correction (different light)', () => {
    n = 0;
    const cool = {verdict: 'too-cool', temperatureShift: 150, tintShift: 0, note: ''};
    const warm = {verdict: 'too-warm', temperatureShift: -600, tintShift: 0, note: ''};
    const ps = [frame({skin: cool}), frame({skin: cool}), frame({skin: cool}), frame({skin: warm})];
    const {d} = plan(ps);
    assert.ok(d[ps[3].id].changes.Temperature < 5000, 'its own direction: ' + JSON.stringify(d[ps[3].id].changes));
    assert.ok(d[ps[0].id].changes.Temperature > 5000);
  });

  test('scene consistency reports white-balance settings before and as planned; auto white balance drift converges', () => {
    n = 0;
    const skin = {verdict: 'too-cool', temperatureShift: 200, tintShift: 0, note: ''};
    const ps = [frame({temp: 4800, skin}), frame({temp: 5000, skin}), frame({temp: 5200, skin})];
    const {after} = plan(ps);
    const c = sceneConsistency(after);
    assert.ok(c.before.whiteBalanceMired > 15 && c.planned.whiteBalanceMired < c.before.whiteBalanceMired / 2, JSON.stringify(c));
  });
}

test('each scene\'s skin-brightness consistency is in the session view and the report: before, planned, then measured after applying', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3')}});
  try {
    x.set(s => { s.photos[101].metrics.faceLuma = 0.06; s.photos[102].metrics.faceLuma = 0.12; });
    const dir = x.analyze(['101', '102']);
    const c = x.show(dir).scenes[0].consistency;
    assert.equal(c.before.frames, 2);
    assert.equal(c.before.brightnessEV, 1);
    assert.match(c.line, /^Skin brightness across 2 faces: 1\.00 EV apart/);
    assert.match(fs.readFileSync(dir + '/report.txt', 'utf8'), /Skin brightness across 2 faces/);
  } finally { x.cleanup(); }
});

test('consistency: deliberate looks are not counted, and a half-applied scene reports no "after" result', async () => {
  const {sceneConsistency, consistencyLine} = await import('../Engine/consistency.mjs');
  const f = (luma, o = {}) => ({baseline: {Exposure2012: 0}, changes: {}, state: 'skipped', ai: {intent: 'none'},
    metrics: {width: 1024, height: 683, subject: {method: 'face', luma, area: 0.05}, faces: [{luma}]}, ...o});
  const post = luma => ({metrics: f(luma).metrics});
  const silhouette = f(0.01, {ai: {intent: 'silhouette'}});
  const a = f(0.05, {changes: {Exposure2012: 1}, state: 'applied', post: post(0.1)}), b = f(0.1);
  let c = sceneConsistency([a, b, silhouette]);
  assert.equal(c.before.frames, 2, 'the silhouette is different on purpose');
  assert.deepEqual([c.before.brightnessEV, c.planned.brightnessEV, c.measured.brightnessEV], [1, 0, 0]);
  assert.match(consistencyLine(c), /1\.00 EV apart before → 0\.00 EV measured after applying/);
  c = sceneConsistency([a, f(0.1, {changes: {Exposure2012: 0.2}, state: 'proposed'})]);
  assert.equal(c.measured, null);
  assert.match(consistencyLine(c), /planned/);
});
