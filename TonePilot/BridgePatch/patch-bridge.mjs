#!/usr/bin/env node
// TonePilot edition of the Lightroom MCP bridge 0.24.1 (MIT, github.com/Automaat/lightroom-mcp).
//
// For JPEG, HEIC and TIFF files Lightroom stores white balance as relative
// IncrementalTemperature / IncrementalTint. Upstream 0.24.1 can neither report nor write
// those two keys, so TonePilot could not correct white balance on non-RAW photos. This
// patch adds exactly those two keys — to the plug-in's write allowlist, to the Develop
// fields it reports, and to the server's write schema — and nothing else.
//
//   node patch-bridge.mjs --check  --plugin <LightroomMCP.lrplugin> [--server <dist>]
//   node patch-bridge.mjs --apply  --plugin <LightroomMCP.lrplugin> [--server <dist>]
//
// It refuses unless the target is exactly upstream 0.24.1 (or already patched), keeps a
// backup of every file it changes, and is idempotent.
import fs from 'node:fs';
import path from 'node:path';

export const PATCH_ID = 'tonepilot-incremental-wb-1';
const MARK = 'TonePilot patch ' + PATCH_ID;
export const UPSTREAM_VERSION = '0.24.1';

const EDITS = {
  plugin: [
    {file: 'HandlerDevelop.lua', anchor: '    "Temperature",\n    "Tint",\n',
      insert: '    "IncrementalTemperature", -- ' + MARK + '\n    "IncrementalTint",\n'},
    {file: 'HandlerMetadata.lua', anchor: '                tint = developSettings.Tint,\n',
      insert: '                incrementalTemperature = developSettings.IncrementalTemperature, -- ' + MARK + '\n' +
              '                incrementalTint = developSettings.IncrementalTint,\n'}
  ],
  server: [
    {file: 'tool-contracts.js', anchor: '    "Temperature",\n    "Tint",\n',
      insert: '    "IncrementalTemperature", // ' + MARK + '\n    "IncrementalTint",\n'}
  ]
};

function pluginVersion(dir) {
  const info = fs.readFileSync(path.join(dir, 'Info.lua'), 'utf8');
  const m = info.match(/VERSION\s*=\s*\{\s*major\s*=\s*(\d+)\s*,\s*minor\s*=\s*(\d+)\s*,\s*revision\s*=\s*(\d+)/);
  return m ? m.slice(1, 4).join('.') : null;
}
function serverVersion(dist) {
  try { return JSON.parse(fs.readFileSync(path.join(dist, '..', 'package.json'), 'utf8')).version; } catch { return null; }
}

// Status of one component: 'patched', 'unpatched', or an explanation of why it can't be.
export function inspect(kind, dir) {
  if (!dir || !fs.existsSync(dir)) return {state: 'missing', detail: 'Not found: ' + dir};
  const version = kind === 'plugin' ? pluginVersion(dir) : serverVersion(dir);
  if (version !== UPSTREAM_VERSION) return {state: 'unsupported', detail: 'Expected bridge ' + UPSTREAM_VERSION + ', found ' + (version || 'unknown')};
  const files = EDITS[kind].map(e => ({e, text: fs.readFileSync(path.join(dir, e.file), 'utf8')}));
  if (files.every(({text}) => text.includes(MARK))) return {state: 'patched', version};
  if (files.some(({text}) => text.includes(MARK))) return {state: 'unsupported', detail: 'Partially patched; restore the backup first'};
  const missing = files.filter(({e, text}) => text.split(e.anchor).length !== 2).map(({e}) => e.file);
  if (missing.length) return {state: 'unsupported', detail: 'Unexpected contents in ' + missing.join(', ')};
  return {state: 'unpatched', version};
}

export function apply(kind, dir, {backupSuffix = '.tonepilot-backup'} = {}) {
  const status = inspect(kind, dir);
  if (status.state === 'patched') return status;
  if (status.state !== 'unpatched') throw new Error(kind + ': ' + status.detail);
  for (const e of EDITS[kind]) {
    const file = path.join(dir, e.file);
    const text = fs.readFileSync(file, 'utf8');
    if (!fs.existsSync(file + backupSuffix)) fs.copyFileSync(file, file + backupSuffix);
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text.replace(e.anchor, e.anchor + e.insert));
    fs.renameSync(tmp, file);
  }
  const after = inspect(kind, dir);
  if (after.state !== 'patched') throw new Error(kind + ': patch did not verify');
  return after;
}

if (import.meta.url === 'file://' + path.resolve(process.argv[1] || '')) {
  const argv = process.argv.slice(2);
  const arg = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
  const targets = [['plugin', arg('plugin')], ['server', arg('server')]].filter(([, d]) => d);
  if (!targets.length || (!argv.includes('--check') && !argv.includes('--apply'))) {
    console.error('Usage: patch-bridge.mjs --check|--apply [--plugin <LightroomMCP.lrplugin>] [--server <dist>]'); process.exit(2);
  }
  const out = {};
  try {
    for (const [kind, dir] of targets) out[kind] = argv.includes('--apply') ? apply(kind, dir) : inspect(kind, dir);
    console.log(JSON.stringify(out));
  } catch (e) { console.log(JSON.stringify({...out, error: e.message})); process.exitCode = 1; }
}
