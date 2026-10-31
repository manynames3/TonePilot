// Scene-batched model calls: several photos of one lighting scene per Codex call, with a
// per-photo fallback whenever the answer can't be matched to its photos.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, existsSync} from 'node:fs';
import {setup, rawPhoto} from './helpers.mjs';
import {buildBatchPrompt, batchSchema, BATCH_SIZE} from '../Engine/ai.mjs';
import {resolvePolicy} from '../Engine/policy.mjs';

const photos = n => Object.fromEntries(Array.from({length: n}, (_, i) => [String(101 + i), rawPhoto('A_0' + (101 + i) + '.CR3')]));
const ids = n => Array.from({length: n}, (_, i) => String(101 + i));
const calls = x => (existsSync(x.state + '.calls') ? readFileSync(x.state + '.calls', 'utf8').split('\n').filter(Boolean).map(Number) : []);
// Batching is opt-in (TONEPILOT_AI_BATCH) until real multi-photo scenes show equal decisions.
const batched = opts => { const x = setup(opts); x.env.TONEPILOT_AI_BATCH = String(BATCH_SIZE); return x; };
const assessed = (x, dir) => x.journal(dir).filter(r => r.type === 'photo-assessed');

test('six photos of one scene are assessed in one model call, journaled per photo', () => {
  const x = batched({photos: photos(6)});
  try {
    const dir = x.analyze(ids(6));
    assert.deepEqual(calls(x), [6]);
    const recs = assessed(x, dir);
    assert.deepEqual(recs.map(r => r.photo).sort(), ids(6));
    for (const r of recs) assert.deepEqual({in: r.stats.inputTokens, out: r.stats.outputTokens, batch: r.stats.batch}, {in: 200, out: 15, batch: 6});
    assert.equal(x.show(dir).status, 'planned');
    assert.ok(x.show(dir).photos.every(p => p.state === 'proposed'));
  } finally { x.cleanup(); }
});

test('a malformed batch answer falls back to one call per photo', () => {
  const x = batched({photos: photos(3), extra: {aiBatchMalformed: true}});
  try {
    const dir = x.analyze(ids(3));
    assert.deepEqual(calls(x), [3, 1, 1, 1]);
    const recs = assessed(x, dir);
    assert.equal(recs.length, 3);
    assert.ok(recs.every(r => r.ai && r.stats.batch === 1 && r.stats.inputTokens === 1200));
    assert.equal(x.show(dir).status, 'planned');
  } finally { x.cleanup(); }
});

test('batched and per-photo journals have the same records and decisions', () => {
  const shape = v => (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, shape(v[k])])) : typeof v);
  const x1 = batched({photos: photos(4)}), x2 = setup({photos: photos(4)});
  try {
    const inBatches = x1.journal(x1.analyze(ids(4)));
    const single = x2.journal(x2.analyze(ids(4)));   // the default: one call per photo
    assert.deepEqual(calls(x1), [4]);
    assert.deepEqual(calls(x2), [1, 1, 1, 1]);
    const key = r => r.type + ':' + (r.photo || '');
    assert.deepEqual(inBatches.map(key).sort(), single.map(key).sort());
    // Only single-photo calls carry an optional reuse key; all shared records remain identical.
    const recordShape = ({key, ...r}) => shape(r);
    const pick = (j, type) => j.filter(r => r.type === type).sort((a, b) => a.photo.localeCompare(b.photo));
    assert.deepEqual(pick(inBatches, 'photo-assessed').map(recordShape), pick(single, 'photo-assessed').map(recordShape));
    assert.deepEqual(pick(inBatches, 'photo-assessed').map(r => r.ai), pick(single, 'photo-assessed').map(r => r.ai));
    assert.deepEqual(pick(inBatches, 'photo-proposed').map(r => r.decision), pick(single, 'photo-proposed').map(r => r.decision));
  } finally { x1.cleanup(); x2.cleanup(); }
});

test('a stopped batched analysis resumes without re-assessing finished photos', async () => {
  const x = batched({photos: photos(8), extra: {aiDelayMs: 1500}});
  try {
    const p = x.start(['--mode', 'analyze', '--ids', JSON.stringify(ids(8))], {TONEPILOT_AI_CONCURRENCY: '1'});
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const until = Date.now() + 20000;
    while (!out.includes('"step":"assess"')) {   // first chunk of 6 done; the chunk of 2 is in flight
      if (Date.now() > until) throw new Error('Timed out waiting for the first chunk');
      await new Promise(r => setTimeout(r, 25));
    }
    p.kill('SIGTERM');
    await new Promise(r => p.on('exit', r));
    const dir = out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'session').dir;
    assert.equal(x.show(dir).status, 'analysis-incomplete');
    assert.equal(assessed(x, dir).length, 6);
    x.set(s => { s.aiDelayMs = 0; });
    const r = x.run(['--mode', 'analyze', '--resume', dir]);
    assert.equal(r.status, 0, JSON.stringify(r.error));
    assert.equal(x.show(dir).status, 'planned');
    const recs = assessed(x, dir);
    assert.equal(recs.length, 8);
    assert.equal(new Set(recs.map(r => r.photo)).size, 8, 'each photo assessed exactly once');
    assert.deepEqual(calls(x).slice(-1), [2], 'resume sends only the unfinished photos');
    assert.equal(x.get().writes.length, 0);
  } finally { x.cleanup(); }
});

test('the batch prompt numbers each image with its own facts; the schema is strict', () => {
  const photo = (id, t) => ({id, baseline: {Temperature: t}, capabilities: {wb: true, wbMode: 'kelvin'}, metrics: null});
  const p = buildBatchPrompt({photos: [photo('a', 5000), photo('b', 6100)], scene: {id: 'S1', photos: ['a', 'b'], reference: 'a'},
    policy: resolvePolicy('Natural', 'Balanced'), enabled: {wb: true, exposure: true, tone: true}});
  assert.match(p, /images 1 to 2 in attachment order/);
  assert.match(p, /Image 1:\nCurrent Develop values: \{"Temperature":5000\}/);
  assert.match(p, /Image 2:\nCurrent Develop values: \{"Temperature":6100\}/);
  assert.equal(p.match(/SKIN TONE/g).length, 1, 'shared instructions appear once');
  const strict = o => o.type !== 'object' || (o.additionalProperties === false && Object.keys(o.properties).every(k => o.required.includes(k)) &&
    Object.values(o.properties).every(v => strict(v.type === 'array' ? v.items : v)));
  const s = batchSchema(2);
  assert.ok(strict(s));
  assert.equal(s.properties.photos.minItems, 2);
  assert.equal(s.properties.photos.maxItems, 2);
});
