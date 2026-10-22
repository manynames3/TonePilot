// The bridge patch on synthetic stand-ins for bridge 0.24.1 (no third-party code runs).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspect, apply} from '../BridgePatch/patch-bridge.mjs';

function fixture(version = '0.24.1') {
  const root = mkdtempSync(join(tmpdir(), 'tp-bridgepatch-'));
  const plugin = join(root, 'LightroomMCP.lrplugin');
  const dist = join(root, 'server', 'dist');
  mkdirSync(plugin); mkdirSync(dist, {recursive: true});
  const [major, minor, revision] = version.split('.');
  writeFileSync(join(plugin, 'Info.lua'), `return { VERSION = { major=${major}, minor=${minor}, revision=${revision}, build=0 } }\n`);
  writeFileSync(join(plugin, 'HandlerDevelop.lua'), 'local KEYS = {\n    "WhiteBalance",\n    "Temperature",\n    "Tint",\n    "Exposure2012",\n}\n');
  writeFileSync(join(plugin, 'HandlerMetadata.lua'), '            developSettings = {\n                temperature = developSettings.Temperature,\n                tint = developSettings.Tint,\n            }\n');
  writeFileSync(join(root, 'server', 'package.json'), JSON.stringify({version}));
  writeFileSync(join(dist, 'tool-contracts.js'), 'export const DEVELOP_SETTING_KEYS = [\n    "WhiteBalance",\n    "Temperature",\n    "Tint",\n];\n');
  return {root, plugin, dist};
}

test('patch adds exactly the two relative white-balance keys, with backups, idempotently', () => {
  const f = fixture();
  try {
    assert.equal(inspect('plugin', f.plugin).state, 'unpatched');
    assert.equal(apply('plugin', f.plugin).state, 'patched');
    assert.equal(apply('server', f.dist).state, 'patched');
    assert.equal(apply('plugin', f.plugin).state, 'patched', 'second run changes nothing');
    const lua = readFileSync(join(f.plugin, 'HandlerDevelop.lua'), 'utf8');
    assert.equal(lua.match(/IncrementalTemperature/g).length, 1);
    assert.match(readFileSync(join(f.plugin, 'HandlerMetadata.lua'), 'utf8'), /incrementalTint = developSettings.IncrementalTint/);
    assert.match(readFileSync(join(f.dist, 'tool-contracts.js'), 'utf8'), /"IncrementalTint",/);
    assert.ok(existsSync(join(f.plugin, 'HandlerDevelop.lua.tonepilot-backup')));
    assert.doesNotMatch(readFileSync(join(f.plugin, 'HandlerDevelop.lua.tonepilot-backup'), 'utf8'), /Incremental/);
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});

test('patch refuses any other bridge version or unexpected contents', () => {
  const f = fixture('0.25.0');
  try {
    assert.equal(inspect('plugin', f.plugin).state, 'unsupported');
    assert.throws(() => apply('plugin', f.plugin), /Expected bridge 0.24.1/);
  } finally { rmSync(f.root, {recursive: true, force: true}); }
  const g = fixture();
  try {
    writeFileSync(join(g.plugin, 'HandlerDevelop.lua'), 'something else entirely\n');
    assert.throws(() => apply('plugin', g.plugin), /Unexpected contents/);
  } finally { rmSync(g.root, {recursive: true, force: true}); }
});
