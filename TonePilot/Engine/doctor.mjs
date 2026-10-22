// First-run and support diagnostics. Read-only: nothing here changes Lightroom,
// the plug-in, Codex or the user's files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {LightroomMCP, readSelection, TESTED_BRIDGE_VERSION} from './lightroom.mjs';

const home = os.homedir();
const run = (cmd, args, timeout = 8000) => spawnSync(cmd, args, {encoding: 'utf8', timeout});
const PLUGIN = path.join(home, 'Library/Application Support/Adobe/Lightroom/Modules/LightroomMCP.lrplugin');

function lightroomApp() {
  const found = run('/usr/bin/mdfind', ["kMDItemCFBundleIdentifier == 'com.adobe.LightroomClassicCC7'"]).stdout?.split('\n').find(Boolean);
  if (found) return found;
  const fallback = '/Applications/Adobe Lightroom Classic/Adobe Lightroom Classic.app';
  return fs.existsSync(fallback) ? fallback : null;
}

export function pluginVersion(dir = PLUGIN) {
  try {
    const info = fs.readFileSync(path.join(dir, 'Info.lua'), 'utf8');
    const m = info.match(/VERSION\s*=\s*\{\s*major\s*=\s*(\d+)\s*,\s*minor\s*=\s*(\d+)\s*,\s*revision\s*=\s*(\d+)/);
    return m ? m[1] + '.' + m[2] + '.' + m[3] : 'unknown';
  } catch { return null; }
}

function bridgeServer() {
  if (process.env.TONEPILOT_MCP_SERVER && fs.existsSync(process.env.TONEPILOT_MCP_SERVER)) return {where: 'bundled', ok: true};
  const cache = path.join(home, '.npm/_npx');
  try {
    for (const d of fs.readdirSync(cache)) {
      const pkg = path.join(cache, d, 'node_modules/@mskalski/lightroom-mcp/package.json');
      try { if (JSON.parse(fs.readFileSync(pkg, 'utf8')).version === TESTED_BRIDGE_VERSION) return {where: 'npm cache', ok: true}; } catch { /* next */ }
    }
  } catch { /* no cache */ }
  return {where: 'download on first use', ok: false};
}

function check(id, ok, title, detail, fix = null, severity = 'required') { return {id, ok: !!ok, severity, title, detail, fix}; }

export async function runDoctor({live = false} = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(check('node', major >= 18, 'Node.js runtime', 'Node ' + process.versions.node,
    major >= 18 ? null : 'Install Node.js 18 or newer.'));

  const app = lightroomApp();
  checks.push(check('lightroom-installed', app, 'Lightroom Classic installed', app || 'Not found',
    app ? null : 'Install Adobe Lightroom Classic.'));
  const running = run('/usr/bin/pgrep', ['-x', 'Adobe Lightroom Classic']).status === 0;
  checks.push(check('lightroom-running', running, 'Lightroom Classic running', running ? 'Running' : 'Not running',
    running ? null : 'Open Lightroom Classic with the catalog you want to edit.'));

  const version = pluginVersion();
  checks.push(check('plugin', version, 'Lightroom MCP plug-in', version ? 'Version ' + version : 'Not installed',
    version ? null : 'Install the Lightroom MCP plug-in (github.com/Automaat/lightroom-mcp), then enable it in File → Plug-in Manager.'));
  if (version) {
    checks.push(check('plugin-version', version === TESTED_BRIDGE_VERSION, 'Plug-in version verified',
      version === TESTED_BRIDGE_VERSION ? 'Matches the tested version' : 'Installed ' + version + '; TonePilot was verified with ' + TESTED_BRIDGE_VERSION,
      version === TESTED_BRIDGE_VERSION ? null : 'Install plug-in version ' + TESTED_BRIDGE_VERSION + ' or proceed with care.', 'recommended'));
  }
  const listening = /LISTEN/.test(run('/usr/sbin/lsof', ['-nP', '-iTCP:58763', '-sTCP:LISTEN']).stdout || '');
  checks.push(check('plugin-server', listening, 'Plug-in server listening', listening ? 'Port 58763' : 'Not listening',
    listening ? null : 'In Lightroom: File → Plug-in Manager → Lightroom MCP → Start Server.'));
  const server = bridgeServer();
  checks.push(check('bridge-server', server.ok, 'Bridge server ' + TESTED_BRIDGE_VERSION, server.where,
    server.ok ? null : 'Connect to the internet once so the pinned bridge can be downloaded, or use a bundled build.', 'recommended'));

  const codex = process.env.TONEPILOT_CODEX || path.join(home, '.local/bin/codex');
  const codexOk = fs.existsSync(codex);
  checks.push(check('codex', codexOk, 'Codex CLI (AI assessment)', codexOk ? 'Installed' : 'Not found',
    codexOk ? null : 'Install the Codex CLI and sign in.'));
  if (codexOk) {
    const status = run(codex, ['login', 'status'], 15000);
    const signedIn = status.status === 0 && /logged in/i.test((status.stdout || '') + (status.stderr || ''));
    checks.push(check('codex-auth', signedIn, 'AI service signed in', signedIn ? 'Signed in' : 'Not signed in',
      signedIn ? null : 'Run “codex login” once in Terminal.'));
  }

  const analyzer = process.env.TONEPILOT_ANALYZER;
  const st = analyzer && fs.existsSync(analyzer) ? run(analyzer, ['--selftest'], 20000) : null;
  checks.push(check('analyzer', st?.status === 0, 'On-device measurements', st?.status === 0 ? 'Self-test passed' : analyzer ? 'Self-test failed' : 'Not bundled',
    st?.status === 0 ? null : 'Rebuild TonePilot; without measurements TonePilot falls back to per-photo AI judgments.', 'recommended'));

  const runs = process.env.TONEPILOT_RUNS_DIR;
  let writable = false;
  try { fs.mkdirSync(runs, {recursive: true, mode: 0o700}); fs.accessSync(runs, fs.constants.W_OK); writable = true; } catch { /* reported below */ }
  checks.push(check('storage', writable, 'Session records', writable ? 'Private folder ready' : 'Not writable',
    writable ? null : 'Check permissions on ~/Library/Application Support/TonePilot.'));

  if (live && running && listening) {
    let detail, ok = false;
    const client = new LightroomMCP({timeout: 15000});
    try {
      await client.connect();
      const sel = await readSelection(client, 1);
      ok = true;
      detail = 'Bridge ' + (client.serverInfo?.version || '?') + ' answered; ' + sel.count + ' photo' + (sel.count === 1 ? '' : 's') + ' selected';
    } catch (e) { detail = e.message; }
    finally { await client.close(); }
    checks.push(check('live-bridge', ok, 'Live Lightroom connection', detail,
      ok ? null : 'Restart the plug-in server in Lightroom’s Plug-in Manager and try again.'));
  }
  const ready = checks.filter(c => c.severity === 'required').every(c => c.ok);
  return {ready, checks};
}
