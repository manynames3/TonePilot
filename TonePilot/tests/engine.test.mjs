import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateSettings, classifyWrite, restorePlan, classifyRestore, diffSnapshot, capabilitiesOf} from '../Engine/guard.mjs';
import {resolvePolicy} from '../Engine/policy.mjs';
import {setup, rawPhoto} from './helpers.mjs';

const ALL = {wb: true, exposure: true, tone: true};
const caps = resolvePolicy('Natural', 'Balanced').caps;
const base = {WhiteBalance: 'As Shot', Temperature: 5200, Tint: 4, Exposure2012: 0, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0};

test('guard: allowlist, disabled groups, per-session and cumulative limits', () => {
  const v = proposed => validateSettings({origin: base, baseline: base, proposed, enabled: ALL, caps});
  assert.throws(() => v({CropAngle: 20}), /allowlisted/);
  assert.throws(() => v({WhiteBalance: 'Custom'}), /allowlisted/, 'WB mode is never proposed');
  assert.throws(() => validateSettings({origin: base, baseline: base, proposed: {Exposure2012: 0.4}, enabled: {...ALL, exposure: false}, caps}), /disabled/);
  assert.throws(() => v({Exposure2012: 0.9}), /Excessive/);
  assert.deepEqual(v({Exposure2012: 0.6}), {Exposure2012: 0.6});
  assert.throws(() => v({Exposure2012: 0}), /No-op/);
  // Cumulative: an earlier session already moved exposure +0.5 from the origin.
  const later = {...base, Exposure2012: 0.5};
  assert.throws(() => validateSettings({origin: base, baseline: later, proposed: {Exposure2012: 1.0}, enabled: ALL, caps}), /Cumulative/);
  // Temperature limits are in mired: 20 mired is ~±600 K at 5200 K but only ~±200 K at 3200 K.
  assert.doesNotThrow(() => v({Temperature: 5700}));
  const tungsten = {...base, Temperature: 3200};
  assert.throws(() => validateSettings({origin: tungsten, baseline: tungsten, proposed: {Temperature: 3600}, enabled: ALL, caps}), /Excessive/);
});

test('guard: write outcomes are judged from read-back values only', () => {
  const pre = {whiteBalance: 'As Shot', temperature: 5200, tint: 4, exposure: 0, contrast: 0};
  const preValues = {WhiteBalance: 'As Shot', Temperature: 5200, Tint: 4, Exposure2012: 0};
  const ok = classifyWrite({preValues, preSnapshot: pre, intended: {Exposure2012: 0.3},
    afterValues: {...preValues, Exposure2012: 0.3}, afterSnapshot: {...pre, exposure: 0.3}});
  assert.equal(ok.outcome, 'verified');
  const none = classifyWrite({preValues, preSnapshot: pre, intended: {Exposure2012: 0.3}, afterValues: preValues, afterSnapshot: pre});
  assert.equal(none.outcome, 'not-applied');
  const extra = classifyWrite({preValues, preSnapshot: pre, intended: {Exposure2012: 0.3},
    afterValues: {...preValues, Exposure2012: 0.3}, afterSnapshot: {...pre, exposure: 0.3, contrast: 9}});
  assert.equal(extra.outcome, 'mismatch'); assert.deepEqual(extra.unexpected, ['contrast']);
  // Temperature flips WB to Custom (allowed) but must not move Tint.
  const wb = classifyWrite({preValues, preSnapshot: pre, intended: {Temperature: 5600},
    afterValues: {...preValues, Temperature: 5600, WhiteBalance: 'Custom'}, afterSnapshot: {...pre, temperature: 5600, whiteBalance: 'Custom'}});
  assert.equal(wb.outcome, 'verified');
  const tintMoved = classifyWrite({preValues, preSnapshot: pre, intended: {Temperature: 5600},
    afterValues: {...preValues, Temperature: 5600}, afterSnapshot: {...pre, temperature: 5600, whiteBalance: 'Custom', tint: 9}});
  assert.equal(tintMoved.outcome, 'mismatch');
});

test('guard: restoring white balance puts the original mode back, not a Custom copy', () => {
  const after = {...base, Temperature: 5600, WhiteBalance: 'Custom'};
  const plan = restorePlan(base, {Temperature: 5600}, after);
  assert.deepEqual(plan.target, {WhiteBalance: 'As Shot'});
  assert.equal(plan.verify.Temperature, 5200); assert.equal(plan.verify.Tint, 4); assert.equal(plan.verify.WhiteBalance, 'As Shot');
  const custom = {...base, WhiteBalance: 'Custom'};
  assert.deepEqual(restorePlan(custom, {Temperature: 5600}, {...custom, Temperature: 5600}).target, {Temperature: 5200});
  const r = classifyRestore({plan, preSnapshot: {temperature: 5600, whiteBalance: 'Custom', tint: 4}, afterValues: base,
    afterSnapshot: {temperature: 5200, whiteBalance: 'As Shot', tint: 4}});
  assert.equal(r.outcome, 'restored');
});

test('guard: format capabilities are explicit about what cannot be written', () => {
  assert.equal(capabilitiesOf({fileFormat: 'VIDEO'}, {}).supported, false);
  const heic = capabilitiesOf({fileFormat: 'HEIC'}, {Exposure2012: 0, Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0, WhiteBalance: 'As Shot'});
  assert.equal(heic.supported, true); assert.equal(heic.wb, false); assert.match(heic.wbNote, /Incremental/);
  assert.match(capabilitiesOf({fileFormat: 'RAW'}, {WhiteBalance: 'As Shot'}).reason, /legacy Lightroom process version/);
  assert.deepEqual(diffSnapshot({a: 1, hsl: {x: 1}}, {a: 1, hsl: {x: 2}}), ['hsl']);
});

test('analysis never writes; apply needs confirmation; restore undoes exactly; repeat restore is a no-op', () => {
  const x = setup({photos: {101: rawPhoto('A_0101.CR3', {metrics: {faceLuma: 0.08, clip: 0.001}})}});
  try {
    const dir = x.analyze(['101']);
    assert.equal(x.get().writes.length, 0, 'analysis must never edit photos');
    let v = x.show(dir);
    assert.equal(v.status, 'planned');
    assert.equal(v.photos[0].state, 'proposed');
    assert.ok(v.photos[0].changes[0].proposed > 0.2 && v.photos[0].changes[0].proposed <= 0.6);
    const unapproved = x.run(['--mode', 'apply', '--session', dir]);
    assert.notEqual(unapproved.status, 0);
    assert.equal(x.get().writes.length, 0, 'missing confirmation must not write');
    const apply = x.run(['--mode', 'apply', '--session', dir, '--confirm']);
    assert.equal(apply.status, 0, JSON.stringify(apply.error));
    v = x.show(dir);
    assert.equal(v.status, 'applied');
    assert.equal(x.get().photos[101].settings.exposure, v.photos[0].changes[0].proposed);
    assert.ok(v.photos[0].after, 'post-apply measurement recorded');
    const restore = x.run(['--mode', 'restore', '--session', dir, '--confirm']);
    assert.equal(restore.status, 0, JSON.stringify(restore.error));
    assert.equal(x.get().photos[101].settings.exposure, 0);
    assert.equal(x.show(dir).status, 'restored');
    const writes = x.get().writes.length;
    const again = x.run(['--mode', 'restore', '--session', dir, '--confirm']);
    assert.notEqual(again.status, 0, 'nothing left to restore');
    assert.equal(x.get().writes.length, writes, 'repeat restore must not write');
    assert.equal(x.show(dir).status, 'restored');
  } finally { x.cleanup(); }
});

test('a changed Lightroom selection blocks applying a plan', () => {
  const x = setup();
  try {
    const dir = x.analyze(['101']);
    x.set(s => { s.selected = []; });
    const apply = x.run(['--mode', 'apply', '--session', dir, '--confirm']);
    assert.notEqual(apply.status, 0);
    assert.match(apply.error.message, /selection changed/);
    assert.equal(x.get().writes.length, 0);
  } finally { x.cleanup(); }
});

test('an unrelated manual edit after analysis makes only that photo stale; others still apply', () => {
  const x = setup({photos: {101: rawPhoto('A_0101.CR3'), 102: rawPhoto('A_0102.CR3')},
    extra: {aiDefault: {skip: false, confidence: 0.95, scene: 'shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
      intent: 'none', skinCast: 'none', subjectExposure: 'under', changes: [{setting: 'Exposure2012', value: 0.4}], reason: 'under'}}});
  try {
    const dir = x.analyze(['101', '102']);
    assert.equal(x.show(dir).counts.proposed, 2);
    x.set(s => { s.photos[101].settings.contrast = 15; });   // photographer touched Contrast only
    const apply = x.run(['--mode', 'apply', '--session', dir, '--confirm']);
    assert.equal(apply.status, 0, JSON.stringify(apply.error));
    const v = x.show(dir);
    const [a, b] = v.photos;
    assert.equal(a.state, 'stale'); assert.deepEqual(a.staleFields, ['contrast']);
    assert.equal(b.state, 'applied');
    assert.equal(x.get().writes.filter(w => w.id === '101').length, 0, 'stale photo never written');
    assert.equal(x.get().photos[101].settings.contrast, 15, 'manual edit preserved');
    assert.equal(v.status, 'applied');
  } finally { x.cleanup(); }
});

test('Lightroom metadata changes (rating, keywords) do not block Develop edits', () => {
  const x = setup();
  try {
    const dir = x.analyze(['101']);
    x.set(s => { s.photos[101].rating = 5; s.photos[101].keywords = ['bride']; });
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 0);
    assert.equal(x.show(dir).status, 'applied');
  } finally { x.cleanup(); }
});

test('approving a subset applies only those photos; the rest stay available', () => {
  const x = setup({photos: {101: rawPhoto('A_0101.CR3'), 102: rawPhoto('A_0102.CR3')},
    extra: {aiDefault: {skip: false, confidence: 0.95, scene: 's', illuminant: 'daylight', mixedLighting: false, backlit: false,
      intent: 'none', skinCast: 'none', subjectExposure: 'under', changes: [{setting: 'Exposure2012', value: 0.4}], reason: 'r'}}});
  try {
    const dir = x.analyze(['101', '102']);
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm', '--only', '["102"]']).status, 0);
    assert.deepEqual(x.get().writes.map(w => w.id), ['102']);
    const v = x.show(dir);
    assert.equal(v.photos[0].state, 'proposed'); assert.equal(v.status, 'applied'); assert.equal(v.actions.apply, true);
  } finally { x.cleanup(); }
});

test('unsupported files are explained, not guessed at', () => {
  const heic = rawPhoto('IMG_9001.HEIC', {fileFormat: 'HEIC', settings: {whiteBalance: 'As Shot', exposure: 0, contrast: 0, highlights: -30, shadows: 20, whites: -10, blacks: -40}});
  const video = rawPhoto('CLIP.MOV', {fileFormat: 'VIDEO'});
  const legacy = rawPhoto('OLD.NEF', {settings: {whiteBalance: 'As Shot', temperature: 5000, tint: 0}});
  const x = setup({photos: {201: heic, 202: video, 203: legacy},
    extra: {aiDefault: {skip: false, confidence: 0.95, scene: 's', illuminant: 'daylight', mixedLighting: false, backlit: false,
      intent: 'none', skinCast: 'green', subjectExposure: 'under',
      changes: [{setting: 'Exposure2012', value: 0.4}, {setting: 'Tint', value: -6}], reason: 'r'}}});
  try {
    const dir = x.analyze(['201', '202', '203']);
    const v = x.show(dir);
    const [h, vid, old] = v.photos;
    assert.equal(vid.state, 'unsupported'); assert.match(vid.reason, /Video/);
    assert.equal(old.state, 'unsupported'); assert.match(old.reason, /process version/);
    assert.equal(h.state, 'proposed');
    assert.deepEqual(h.changes.map(c => c.key), ['Exposure2012'], 'no Tint on a HEIC');
    assert.ok(h.warnings.some(w => /Incremental/.test(w)));
  } finally { x.cleanup(); }
});

test('repeated sessions cannot compound past the cumulative cap; a manual edit resets ownership', () => {
  const ai = {skip: false, confidence: 0.95, scene: 's', illuminant: 'daylight', mixedLighting: false, backlit: false,
    intent: 'none', skinCast: 'none', subjectExposure: 'under', reason: 'under'};
  const x = setup({photos: {101: rawPhoto('A_0101.CR3', {metrics: {faceLuma: 0.03, clip: 0, clipAtEV: Array(20).fill(0)}})}});
  try {
    x.set(s => { s.aiDefault = {...ai, changes: [{setting: 'Exposure2012', value: 1.5}]}; });
    const one = x.analyze(['101'], ['--strength', 'Balanced']);
    assert.equal(x.run(['--mode', 'apply', '--session', one, '--confirm']).status, 0);
    assert.equal(x.get().photos[101].settings.exposure, 0.6, 'first pass stops at the Balanced cap');
    x.set(s => { s.aiDefault = {...ai, changes: [{setting: 'Exposure2012', value: 2.1}]}; });
    const two = x.analyze(['101'], ['--strength', 'Balanced']);
    const v = x.show(two);
    assert.equal(v.photos[0].state, 'skipped', 'cumulative cap reached');
    assert.ok(v.photos[0].prior, 'earlier TonePilot session is surfaced');
    assert.equal(v.photos[0].changes.length, 0);
    x.set(s => { s.photos[101].settings.exposure = 0.2; });   // photographer takes over
    const three = x.analyze(['101'], ['--strength', 'Balanced']);
    const w = x.show(three);
    assert.equal(w.photos[0].prior, null);
    assert.equal(w.photos[0].changes[0].proposed, 0.8, 'limits now measured from the photographer\'s value');
  } finally { x.cleanup(); }
});

test('sessions survive relaunch: the list is rebuilt from journals with derived status', () => {
  const x = setup();
  try {
    const dir = x.analyze(['101']);
    x.run(['--mode', 'apply', '--session', dir, '--confirm']);
    const list = x.run(['--mode', 'sessions']).complete.sessions;
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'applied'); assert.equal(list[0].actions.restore, true);
    const discard = x.run(['--mode', 'discard', '--session', dir, '--confirm']);
    assert.notEqual(discard.status, 0, 'an applied session cannot be discarded');
  } finally { x.cleanup(); }
});
