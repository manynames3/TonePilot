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
