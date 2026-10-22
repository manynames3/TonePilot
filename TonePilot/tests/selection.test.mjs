// The apply-time selection interlock: cheap enough for gallery-sized jobs, still stops
// the run when the photographer changes the Lightroom selection.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup, rawPhoto} from './helpers.mjs';

const UNDER = {skip: false, confidence: 0.95, scene: 'shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
  intent: 'none', skinCast: 'none', subjectExposure: 'under', changes: [{setting: 'Exposure2012', value: 0.4}], reason: 'under'};

function gallery(n, extra = {}) {
  const photos = Object.fromEntries(Array.from({length: n}, (_, i) => [String(101 + i), rawPhoto('G_' + (101 + i) + '.CR3')]));
  const selected = Object.keys(photos);
  return {photos: {...photos, ...extra}, selected};
}
function planned(n, extra) {
  const g = gallery(n, extra);
  const x = setup({photos: g.photos, selected: g.selected, extra: {aiDefault: UNDER}});
  const dir = x.analyze(g.selected);
  assert.equal(x.show(dir).counts.proposed, n);
  x.set(s => { s.selectionCalls = []; });   // count only what apply does
  return {x, dir, ids: g.selected};
}
const fullReads = calls => calls.filter(c => c.limit > 1);
const rowsRead = calls => calls.reduce((t, c) => t + c.rows, 0);
const finished = x => (dir => x.journal(dir).filter(r => r.type === 'apply-finished').at(-1));

test('apply reads the full selection O(n/N) times instead of before every photo', () => {
  const {x, dir} = planned(12);
  try {
    const r = x.run(['--mode', 'apply', '--session', dir, '--confirm'], {TONEPILOT_SELECTION_FULL_EVERY: '4'});
    assert.equal(r.status, 0, JSON.stringify(r.error));
    assert.equal(x.get().writes.length, 12);
    const calls = x.get().selectionCalls;
    // Start, every 4 photos, and before the last: 4 full reads instead of 13.
    assert.equal(fullReads(calls).length, 4);
    assert.ok(fullReads(calls).length <= 2 + Math.ceil(12 / 4));
    assert.equal(calls.length - fullReads(calls).length, 9, 'one sampled row for every other photo');
    assert.equal(rowsRead(calls), 4 * 12 + 9, 'was 13 × 12 = 156 rows');
    assert.deepEqual(finished(x)(dir).selectionReads, {full: 4, sampled: 9});
    assert.equal(x.show(dir).status, 'applied');
  } finally { x.cleanup(); }
});

test('at the 20-photo pilot limit the default check reads 59 rows instead of 420', () => {
  const {x, dir} = planned(20);
  try {
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 0);
    const calls = x.get().selectionCalls;
    assert.equal(fullReads(calls).length, 2, 'start and before the last photo');
    assert.equal(rowsRead(calls), 2 * 20 + 19);
  } finally { x.cleanup(); }
});

test('a same-size selection swap stops the run within N photos and never writes outside the authorization', () => {
  const {x, dir, ids} = planned(12, {999: rawPhoto('NOT_AUTHORIZED.CR3')});
  try {
    // After the 2nd write the photographer swaps G_106 for another photo: the count is
    // unchanged, so only a membership check can notice.
    x.set(s => { s.faults = {swapSelectionAfterWrite: {n: 2, from: '106', to: '999'}}; });
    const r = x.run(['--mode', 'apply', '--session', dir, '--confirm'], {TONEPILOT_SELECTION_FULL_EVERY: '4'});
    assert.equal(r.status, 0);
    assert.match(r.complete.stopped, /selection changed/);
    const writes = x.get().writes;
    assert.ok(writes.every(w => ids.includes(w.id)), 'only authorized photos written');
    assert.ok(!writes.some(w => w.id === '999'));
    assert.ok(writes.length > 2 && writes.length <= 2 + 4, 'stopped within N photos of the change: ' + writes.length);
    const v = x.show(dir);
    assert.equal(v.unresolved.length, 0);
    assert.equal(v.status, 'partially-applied');
    // Reselecting the original photos lets the photographer finish the job.
    x.set(s => { s.faults = {}; s.selected = ids; });
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 0);
    assert.equal(x.show(dir).status, 'applied');
    assert.equal(x.get().writes.length, 12, 'no photo written twice');
  } finally { x.cleanup(); }
});

test('the rotating sample usually catches a swap before the periodic full check', () => {
  const {x, dir, ids} = planned(12, {999: rawPhoto('NOT_AUTHORIZED.CR3')});
  try {
    x.set(s => { s.faults = {swapSelectionAfterWrite: {n: 1, from: '103', to: '999'}}; });
    const r = x.run(['--mode', 'apply', '--session', dir, '--confirm']);   // default N = 25
    assert.match(r.complete.stopped, /selection changed/);
    assert.equal(x.get().writes.length, 2, 'the sample at position 3 found the swapped photo');
    assert.ok(x.get().writes.every(w => ids.includes(w.id)));
  } finally { x.cleanup(); }
});
