// Read-only Lightroom bridge behaviour: selection reading, failures, version checks.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFileSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
import {setup, rawPhoto} from './helpers.mjs';

test('inspect reads the selection without any write call', () => {
  const x = setup({photos: {101: rawPhoto('DSC_0101.NEF'), 102: rawPhoto('DSC_0102.NEF')}});
  try {
    const r = x.run(['--mode', 'inspect']);
    assert.equal(r.status, 0);
    assert.equal(r.complete.count, 2);
    assert.deepEqual(r.complete.photos.map(p => [p.filename, p.format]), [['DSC_0101.NEF', 'NEF'], ['DSC_0102.NEF', 'NEF']]);
    assert.equal(x.get().writes.length, 0);
    assert.equal(r.complete.limit, 20);
  } finally { x.cleanup(); }
});

test('an empty selection is reported, never invented', () => {
  const x = setup({selected: []});
  try {
    const r = x.run(['--mode', 'inspect']);
    assert.equal(r.status, 0);
    assert.equal(r.complete.count, 0);
    assert.deepEqual(r.complete.photos, []);
  } finally { x.cleanup(); }
});

test('a selection over the pilot limit is reported as truncated', () => {
  const photos = Object.fromEntries(Array.from({length: 23}, (_, i) => [String(200 + i), rawPhoto('P_' + i + '.CR3')]));
  const x = setup({photos});
  try {
    const r = x.run(['--mode', 'inspect']);
    assert.equal(r.complete.count, 23);
    assert.equal(r.complete.truncated, true);
    const a = x.run(['--mode', 'analyze', '--ids', JSON.stringify(Object.keys(photos))]);
    assert.notEqual(a.status, 0, 'analysis refuses more than the pilot limit');
  } finally { x.cleanup(); }
});

test('a disconnected plug-in is an error, not an empty success', () => {
  const x = setup();
  try {
    const dead = join(x.temp, 'dead-bridge.mjs');
    writeFileSync(dead, `process.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) { const m = JSON.parse(l);
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result:{serverInfo:{version:'0.24.1'}}})+'\\n');
      else if (m.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result:{isError:true, content:[{type:'text', text:'Lightroom plugin not connected'}]}})+'\\n'); } });`);
    chmodSync(dead, 0o755);
    const r = x.run(['--mode', 'inspect'], {TONEPILOT_MCP_ARGS: JSON.stringify([dead])});
    assert.equal(r.status, 1);
    assert.match(r.error.message, /plugin not connected/);
  } finally { x.cleanup(); }
});

test('an unverified bridge version is surfaced as a warning', () => {
  const x = setup();
  try {
    const r = x.run(['--mode', 'inspect'], {TONEPILOT_MOCK_BRIDGE_VERSION: '0.30.0'});
    assert.equal(r.status, 0);
    assert.ok(r.events.some(e => e.type === 'warning' && /not been verified/.test(e.message)));
  } finally { x.cleanup(); }
});

test('the bridge is pinned to the verified version, never a floating npx install', async () => {
  const {BRIDGE_PACKAGE, TESTED_BRIDGE_VERSION} = await import('../Engine/lightroom.mjs');
  assert.equal(BRIDGE_PACKAGE, '@mskalski/lightroom-mcp@' + TESTED_BRIDGE_VERSION);
  const lock = JSON.parse((await import('node:fs')).readFileSync(new URL('../BridgeServer/package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/@mskalski/lightroom-mcp'].version, TESTED_BRIDGE_VERSION);
  assert.ok(lock.packages['node_modules/@mskalski/lightroom-mcp'].integrity.startsWith('sha512-'));
});

test('doctor reports every required check and never needs Lightroom to answer', () => {
  const x = setup();
  try {
    const r = x.run(['--mode', 'doctor']);
    assert.equal(r.status, 0);
    const ids = r.complete.checks.map(c => c.id);
    for (const id of ['node', 'lightroom-installed', 'lightroom-running', 'plugin', 'plugin-server', 'codex', 'analyzer', 'storage']) assert.ok(ids.includes(id), id);
    assert.ok(r.complete.checks.every(c => typeof c.title === 'string' && (c.ok || c.fix)), 'every failing check says how to fix it');
  } finally { x.cleanup(); }
});

test('a preview that fails briefly is retried; one that never renders flags only that photo', () => {
  const x = setup({photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3'), 103: rawPhoto('C.CR3')},
    faults: {previewFailFirst: {101: 2}, previewOffline: ['103']}});
  try {
    const r = x.run(['--mode', 'analyze', '--ids', '["101","102","103"]']);
    assert.equal(r.status, 0, JSON.stringify(r.error));
    const v = x.show(r.complete.dir);
    assert.equal(v.status, 'planned');
    assert.equal(v.photos[0].state, 'proposed', 'recovered after two failed attempts');
    assert.equal(v.photos[1].state, 'proposed');
    assert.equal(v.photos[2].state, 'flagged');
    assert.match(v.photos[2].reason, /could not render a preview \(error loading thumb\)/);
    assert.equal(x.get().writes.length, 0);
  } finally { x.cleanup(); }
});
