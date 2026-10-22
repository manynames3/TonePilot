// TonePilot's own Lightroom plug-in: its Lua source, the Node client, and what the engine
// does with it (snapshots, Show in Lightroom, fallback to the MCP bridge). The plug-in
// itself only runs inside Lightroom; here its Lua is checked statically and, when a Lua
// interpreter is installed, run against stub SDK objects.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setup, rawPhoto} from './helpers.mjs';
import {PLUGIN_WRITABLE} from './mock-core.mjs';
import {ALLOW, diffSnapshot, classifyWrite} from '../Engine/guard.mjs';
import {TonePilotBridge} from '../Engine/tonepilot-bridge.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(folder, '../LightroomPlugin/TonePilot.lrplugin');
const lua = name => readFileSync(join(PLUGIN, name), 'utf8');
const THREE = () => ({101: rawPhoto('A_0101.CR3'), 102: rawPhoto('A_0102.CR3'), 103: rawPhoto('A_0103.CR3')});
const UNDER = {skip: false, confidence: 0.95, scene: 'shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
  intent: 'none', skinCast: 'none', subjectExposure: 'under', changes: [{setting: 'Exposure2012', value: 0.4}], reason: 'under'};
const planned = (x, ids, env) => { x.set(s => { s.aiDefault = UNDER; }); return x.run(['--mode', 'analyze', '--ids', JSON.stringify(ids)], env).complete.dir; };
const apply = (x, dir, env) => x.run(['--mode', 'apply', '--session', dir, '--confirm'], env);

test('the plug-in writes exactly the engine\'s keys and serves only its eight actions', () => {
  const source = lua('Actions.lua');
  const writable = source.match(/local WRITABLE = \{([^}]*)\}/)[1].match(/"(\w+)"/g).map(k => k.slice(1, -1));
  assert.deepEqual([...writable].sort(), ['WhiteBalance', ...Object.keys(ALLOW)].sort());
  assert.deepEqual(writable, PLUGIN_WRITABLE, 'the mock plug-in mirrors the real allowlist');
  const actions = [...source.matchAll(/^function handlers\.(\w+)/gm)].map(m => m[1]).sort();
  assert.deepEqual(actions, ['create_snapshot', 'get_photo_metadata', 'get_photo_preview', 'get_selected_photos',
    'hello', 'select_photos', 'set_develop_settings', 'writable_keys']);
  assert.match(source, /applyDevelopSettings\(settings, history\)/, 'the History panel takes its step name from here');
  assert.match(source, /HISTORY_STEPS = \{ \["TonePilot first pass"\] = true, \["TonePilot restore"\] = true \}/);
  const info = lua('Info.lua').match(/VERSION = \{ major = (\d+), minor = (\d+), revision = (\d+)/).slice(1).join('.');
  assert.equal(source.match(/version = "([\d.]+)"/)[1], info, 'hello reports the Info.lua version');
});

test('the plug-in Lua runs against stub SDK objects (allowlist, JSON, token, bridge file)', t => {
  if (spawnSync('lua', ['-v']).status !== 0) return t.skip('no Lua interpreter installed (brew install lua)');
  const home = mkdtempSync(join(tmpdir(), 'tonepilot-lua-'));
  try {
    const r = spawnSync('lua', [join(folder, 'plugin-harness.lua'), PLUGIN, home], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /plugin harness: ok/);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('every request needs the bridge-file token; a wrong token falls back to the MCP bridge', async () => {
  const x = setup({bridge: 'tonepilot'});
  try {
    const file = x.env.TONEPILOT_BRIDGE_FILE;
    const good = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({...good, token: 'f'.repeat(64)}));
    const client = new TonePilotBridge({file});
    await assert.rejects(client.connect(), e => e.kind === 'tool' && /Unauthorized/.test(e.message));
    await client.close();
    const r = x.run(['--mode', 'inspect']);
    assert.equal(r.status, 0, JSON.stringify(r.error));
    assert.equal(r.complete.bridgeKind, 'mcp');
    writeFileSync(file, JSON.stringify(good));
    assert.equal(x.run(['--mode', 'inspect']).complete.bridgeKind, 'tonepilot');
  } finally { x.cleanup(); }
});

test('the client refuses keys outside the plug-in allowlist and reports relative white balance as writable', async () => {
  const x = setup({bridge: 'tonepilot'});
  const client = new TonePilotBridge({file: x.env.TONEPILOT_BRIDGE_FILE});
  try {
    await client.connect();
    assert.equal(client.kind, 'tonepilot');
    assert.deepEqual([...client.writableKeys], PLUGIN_WRITABLE);
    await assert.rejects(client.tool('set_develop_settings', {photo_id: '101', settings: {Contrast2012: 10}}),
      e => e.kind === 'tool' && /Contrast2012/.test(e.message));
    await assert.rejects(client.tool('set_develop_settings', {photo_id: '101', settings: {Exposure2012: 0.2, CropTop: 0.1}}), /CropTop/);
    assert.equal(x.get().writes.length, 0);
    assert.equal(x.get().photos[101].settings.contrast, 0);
  } finally { await client.close(); x.cleanup(); }
});

test('the client reconnects when the plug-in drops its first response connections', async () => {
  const x = setup({bridge: 'tonepilot', faults: {dropResponseConnections: 2}});
  const client = new TonePilotBridge({file: x.env.TONEPILOT_BRIDGE_FILE});
  try {
    await client.connect();
    assert.equal(client.serverInfo.version, '0.1.0');
    assert.equal((await client.tool('get_selected_photos', {limit: 5})).count, 1);
  } finally { await client.close(); x.cleanup(); }
});

test('a late reply meant for an engine that died is never taken as the next engine\'s answer', async () => {
  const x = setup({bridge: 'tonepilot', faults: {writeDelayMs: 400}, photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3')}});
  const a = new TonePilotBridge({file: x.env.TONEPILOT_BRIDGE_FILE}), b = new TonePilotBridge({file: x.env.TONEPILOT_BRIDGE_FILE});
  try {
    await a.connect();
    a.tool('set_develop_settings', {photo_id: '101', settings: {Exposure2012: 0.3}}).catch(() => {});
    await new Promise(r => setTimeout(r, 20));
    a.requests.destroy(); a.responses.destroy(); a.closed = true;   // engine A killed mid-write
    await b.connect();
    const r = await b.tool('set_develop_settings', {photo_id: '102', settings: {Exposure2012: 0.2}});
    assert.equal(String(r.photo_id), '102', 'B got its own answer, not A\'s late one');
    assert.equal(x.get().photos[102].settings.exposure, 0.2);
  } finally { await b.close(); x.cleanup(); }
});

test('without a bridge file, or with a stale one, the engine uses the MCP bridge', () => {
  const x = setup();
  try {
    assert.equal(x.run(['--mode', 'inspect']).complete.bridgeKind, 'mcp');
    writeFileSync(x.env.TONEPILOT_BRIDGE_FILE, JSON.stringify({version: 1, requestPort: 9, responsePort: 9, token: 'f'.repeat(64)}));
    const r = x.run(['--mode', 'inspect']);
    assert.equal(r.status, 0, JSON.stringify(r.error));
    assert.equal(r.complete.bridgeKind, 'mcp', 'Lightroom quit: bridge.json left behind, nothing listening');
  } finally { x.cleanup(); }
});

test('a Lightroom snapshot is made once per photo, before its first write, and never blocks it', () => {
  const x = setup({bridge: 'tonepilot', photos: THREE()});
  try {
    const dir = planned(x, ['101', '102', '103']);
    x.set(s => { s.faults = {errorOnWrite: 1}; });
    assert.equal(apply(x, dir).status, 0);
    x.set(s => { s.faults = {}; });
    assert.equal(apply(x, dir).status, 0, 'the failed photo is retried');
    assert.equal(x.run(['--mode', 'restore', '--session', dir, '--confirm']).status, 0);
    const name = 'TonePilot before ' + dir.slice(-6);
    assert.deepEqual(x.get().snapshots.map(s => [s.id, s.name]), [['101', name], ['102', name], ['103', name]], 'one each, none on retry or restore');
    assert.deepEqual(x.get().writes.map(w => w.history), [undefined, undefined, undefined, 'TonePilot restore', 'TonePilot restore', 'TonePilot restore'],
      'applies use the plug-in\'s default History step; restores are named');
    const journal = x.journal(dir);
    const records = journal.filter(r => r.type === 'photo-snapshot');
    assert.equal(records.length, 3);
    assert.ok(records.every(r => r.supported && r.created && r.name === name));
    for (const id of ['101', '102', '103']) {
      const intent = journal.findIndex(r => r.type === 'snapshot-intent' && r.photo === id);
      const snap = journal.findIndex(r => r.type === 'photo-snapshot' && r.photo === id);
      assert.ok(intent >= 0 && intent < snap, 'the snapshot, a catalog write, is journaled before it is made');
      assert.ok(snap < journal.findIndex(r => r.type === 'write-intent' && r.photo === id), 'before the photo\'s first write');
    }
    const v = x.show(dir);
    assert.ok(v.photos.every(p => p.lightroomSnapshot === name));
  } finally { x.cleanup(); }
});

test('without snapshot support the write still happens and the journal says so', () => {
  const x = setup({bridge: 'tonepilot', faults: {snapshotUnsupported: true}});
  try {
    const dir = planned(x, ['101']);
    assert.equal(apply(x, dir).status, 0);
    assert.equal(x.show(dir).status, 'applied');
    const [record] = x.journal(dir).filter(r => r.type === 'photo-snapshot');
    assert.deepEqual([record.supported, record.created], [false, false]);
    assert.equal(x.show(dir).photos[0].lightroomSnapshot, null);
    assert.equal(x.get().writes.length, 1);
  } finally { x.cleanup(); }
});

test('the MCP bridge path is unchanged: no snapshot call, no snapshot record', () => {
  const x = setup();
  try {
    const dir = planned(x, ['101']);
    assert.equal(apply(x, dir).status, 0);
    assert.equal(x.journal(dir).filter(r => r.type === 'photo-snapshot').length, 0);
    assert.equal(x.get().snapshots, undefined);
  } finally { x.cleanup(); }
});

test('select mode shows photos in Lightroom without touching Develop; it needs TonePilot\'s plug-in', () => {
  const x = setup({bridge: 'tonepilot', photos: THREE()});
  try {
    const r = x.run(['--mode', 'select', '--ids', '["102","103"]']);
    assert.equal(r.status, 0, JSON.stringify(r.error));
    assert.deepEqual([r.complete.state, r.complete.selected, r.complete.missing], ['read-only', 2, []]);
    assert.deepEqual(x.get().selected, ['102', '103']);
    assert.equal(x.get().writes.length, 0);
    assert.notEqual(x.run(['--mode', 'select', '--ids', '["abc"]']).status, 0, 'IDs are validated');
    const mcp = x.run(['--mode', 'select', '--ids', '["101"]'], {TONEPILOT_BRIDGE_FILE: join(x.temp, 'none.json')});
    assert.notEqual(mcp.status, 0);
    assert.match(mcp.error.message, /TonePilot Lightroom plug-in/);
  } finally { x.cleanup(); }
});

test('the plug-in sees Develop changes the MCP bridge cannot (a crop after analysis makes the photo stale)', () => {
  for (const bridge of ['tonepilot', 'mcp']) {
    const x = setup({bridge, photos: {101: rawPhoto('A_0101.CR3', {hidden: {CropTop: 0, LensProfileEnable: 0}})}});
    try {
      const dir = planned(x, ['101']);
      x.set(s => { s.photos[101].hidden.CropTop = 0.12; });
      assert.equal(apply(x, dir).status, 0);
      const p = x.show(dir).photos[0];
      if (bridge === 'tonepilot') {
        assert.equal(p.state, 'stale'); assert.deepEqual(p.staleFields, ['CropTop']);
        assert.equal(x.get().writes.length, 0);
      } else assert.equal(p.state, 'applied', 'invisible to the MCP bridge');
    } finally { x.cleanup(); }
  }
});

test('a session analyzed through the MCP bridge can be applied and restored through the plug-in', () => {
  const x = setup({bridge: 'tonepilot', photos: {101: rawPhoto('A_0101.CR3', {hidden: {CropTop: 0}})}});
  try {
    const dir = planned(x, ['101'], {TONEPILOT_BRIDGE_FILE: join(x.temp, 'none.json')});
    assert.equal(x.journal(dir)[0].engine.bridgeKind, 'mcp');
    const r = apply(x, dir);
    assert.equal(r.status, 0, JSON.stringify(r.error));
    assert.equal(x.show(dir).status, 'applied', 'fields only one bridge reports are not counted as changes');
    assert.equal(x.run(['--mode', 'restore', '--session', dir, '--confirm']).status, 0);
    assert.equal(x.show(dir).status, 'restored');
  } finally { x.cleanup(); }
});

test('snapshots from different bridges compare only what both report (JPEG/HEIC relative white balance)', () => {
  // Through the plug-in a HEIC reports incremental white balance and `full`; the stock MCP bridge reports neither.
  const plugin = {whiteBalance: 'As Shot', exposure: 0, shadows: 0, contrast: 0, incrementalTemperature: 0, incrementalTint: 0,
    full: {WhiteBalance: 'As Shot', Exposure2012: 0, IncrementalTemperature: 0, IncrementalTint: 0, CropTop: 0}};
  const mcp = {whiteBalance: 'As Shot', exposure: 0, shadows: 0, contrast: 0};
  assert.deepEqual(diffSnapshot(plugin, mcp), [], 'no false "edited after analysis"');
  assert.deepEqual(diffSnapshot(mcp, plugin), []);
  assert.deepEqual(diffSnapshot(plugin, {...mcp, exposure: 0.5}), ['exposure'], 'a real change is still seen');
  assert.deepEqual(diffSnapshot(mcp, {...mcp, incrementalTint: 3}), ['incrementalTint'], 'same bridge: a field appearing is a change');
  const pre = {WhiteBalance: 'As Shot', Exposure2012: 0};
  const c = classifyWrite({preValues: pre, preSnapshot: plugin, intended: {Exposure2012: 0.3},
    afterValues: {WhiteBalance: 'As Shot', Exposure2012: 0}, afterSnapshot: mcp});
  assert.equal(c.outcome, 'not-applied', 'a write that never landed is not counted as present');
});
