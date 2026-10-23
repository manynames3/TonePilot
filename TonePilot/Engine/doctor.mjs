// First-run and support diagnostics. Read-only: nothing here changes Lightroom,
// the plug-in, Codex, AWS or the user's files, and no secret is ever printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {childEnv} from './secrets.mjs';
import {connectLightroom, readSelection, TESTED_BRIDGE_VERSION} from './lightroom.mjs';
import {bridgeFile} from './tonepilot-bridge.mjs';
import {PROVIDERS} from './ai.mjs';

const home = os.homedir();
const run = (cmd, args, timeout = 8000) => spawnSync(cmd, args, {encoding: 'utf8', timeout, env: childEnv()});
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

// AWS profile names in the shared credentials and config files (never their contents).
function awsProfiles(env) {
  const names = new Set();
  for (const [file, config] of [[env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws/credentials'), false],
    [env.AWS_CONFIG_FILE || path.join(home, '.aws/config'), true]]) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const [, section] of text.matchAll(/^\s*\[\s*([^\]]+?)\s*\]/gm)) {
      if (!config || section === 'default') names.add(section);
      else if (section.startsWith('profile ')) names.add(section.slice(8).trim());
    }
  }
  return names;
}

// Where Bedrock credentials will come from, in the SDK's order. Names the source only.
function bedrockSource(env) {
  const profiles = awsProfiles(env);
  if (env.TONEPILOT_AWS_PROFILE) {
    const p = env.TONEPILOT_AWS_PROFILE;
    return profiles.has(p) ? {ok: true, detail: 'AWS profile “' + p + '” (~/.aws)'}
      : {ok: false, detail: 'AWS profile “' + p + '” not found in ~/.aws',
        fix: 'Create it with “aws configure --profile ' + p + '”, or clear the profile in Setup.'};
  }
  if (env.AWS_BEARER_TOKEN_BEDROCK) return {ok: true, detail: 'Bedrock API key'};
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return {ok: true, detail: 'AWS access keys from the environment'};
  const p = env.AWS_PROFILE || 'default';
  if (profiles.has(p)) return {ok: true, detail: 'AWS profile “' + p + '” (~/.aws)'};
  return {ok: false, detail: 'No AWS credentials found', fix: 'Add a Bedrock API key in Setup, or sign in with the AWS CLI (“aws configure” or “aws sso login”).'};
}

// Only the selected provider is checked, so only its checks are required.
async function aiChecks(env, live) {
  const name = env.TONEPILOT_AI_PROVIDER || 'codex';
  if (name === 'codex') {
    const codex = env.TONEPILOT_CODEX || path.join(home, '.local/bin/codex');
    const codexOk = fs.existsSync(codex);
    const out = [check('codex', codexOk, 'Codex CLI (AI assessment)', codexOk ? 'Installed' : 'Not found',
      codexOk ? null : 'Install the Codex CLI and sign in.')];
    if (codexOk) {
      const status = run(codex, ['login', 'status'], 15000);
      const signedIn = status.status === 0 && /logged in/i.test((status.stdout || '') + (status.stderr || ''));
      out.push(check('codex-auth', signedIn, 'AI service signed in', signedIn ? 'Signed in' : 'Not signed in',
        signedIn ? null : 'Run “codex login” once in Terminal.'));
    }
    return out;
  }
  if (!PROVIDERS.includes(name)) return [check('ai-provider', false, 'AI service', 'Unknown service “' + name + '”', 'Choose an AI service in Setup.')];
  // OpenAI Decisions API: the key, and with --live one tiny text-only question.
  if (name === 'openai') {
    const key = env.OPENAI_API_KEY || '';
    const out = [check('ai-credentials', !!key, 'OpenAI API key', key ? 'Saved, ending in ' + key.slice(-4) : 'Not set', key ? null : 'Add your OpenAI API key in Setup.')];
    if (live && key) {
      let ok = false, detail;
      try {
        const {decisionsProvider, DECISIONS_MODEL} = await import('./decisions.mjs');
        const started = Date.now();
        await decisionsProvider(env).call({model: DECISIONS_MODEL, input: 'The sky is blue.',
          questions: [{type: 'predicate', name: 'ok', instructions: 'The statement is true.'}]}, {timeoutMs: 20000});
        ok = true; detail = DECISIONS_MODEL + ' answered in ' + (Date.now() - started) + ' ms';
      } catch (e) { detail = String(e?.message || e).slice(0, 200); }
      out.push(check('ai-live', ok, 'AI service answered', detail, ok ? null : 'Check the API key and that your OpenAI account has API credit.'));
    }
    return out;
  }
  // TonePilot Cloud holds the model credentials; here only its address and the license
  // (whose expiry is readable without the signing secret) are checked. No model call.
  if (name === 'cloud') {
    let url = null;
    try { url = new URL(env.TONEPILOT_CLOUD_URL || ''); } catch { /* not set or not a URL */ }
    const local = url && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const urlOk = !!url && (url.protocol === 'https:' || local);
    const [version, id, expires] = (env.TONEPILOT_LICENSE || '').split('.');
    const days = Math.floor((Number(expires) * 1000 - Date.now()) / 86400000);
    const licenseOk = version === 'tp1' && !!id && Number.isFinite(days) && days >= 0;
    return [check('cloud-url', urlOk, 'TonePilot Cloud address', url ? url.host : 'Not set', urlOk ? null : 'TonePilot Cloud needs an https address.'),
      check('cloud-license', licenseOk, 'TonePilot license', licenseOk ? 'Valid for ' + days + ' more days' : version === 'tp1' && id ? 'Expired' : 'Not set or not readable',
        licenseOk ? null : 'Renew or re-enter your TonePilot license.')];
  }

  const out = [];
  if (name === 'bedrock') {
    const source = bedrockSource(env);
    out.push(check('ai-credentials', source.ok, 'Amazon Bedrock access', source.detail, source.fix));
    const region = env.TONEPILOT_AWS_REGION || env.AWS_REGION || 'us-east-1';
    const regionOk = /^[a-z]{2}(-gov)?-[a-z]+-\d+$/.test(region);
    out.push(check('ai-region', regionOk, 'AWS region', region, regionOk ? null : 'Enter an AWS region such as us-east-1 in Setup.'));
  } else {
    const key = env.ANTHROPIC_API_KEY || '';
    out.push(check('ai-credentials', !!key, 'Anthropic API key', key ? 'Saved, ending in ' + key.slice(-4) : 'Not set',
      key ? null : 'Add your Anthropic API key in Setup.'));
  }
  // One tiny text-only call through the same client the assessment uses.
  if (live && out.every(c => c.ok)) {
    let ok = false, detail;
    try {
      const r = await (await import('./claude.mjs')).pingClaude(name, env);
      ok = true;
      detail = r.model + ' answered in ' + r.ms + ' ms';
    } catch (e) { detail = String(e?.message || e).slice(0, 200); }
    out.push(check('ai-live', ok, 'AI service answered', detail, ok ? null : name === 'bedrock'
      ? 'Check the credentials and region, and that this AWS account has access to the model in Bedrock.'
      : 'Check the API key and that your Anthropic account can use the model.'));
  }
  return out;
}

export async function runDoctor({live = false} = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  const bundled = process.execPath.endsWith('.app/Contents/Helpers/node');
  checks.push(check('node', major >= 18, 'Node.js runtime', 'Node ' + process.versions.node + (bundled ? ' (bundled)' : ' (system)'),
    major >= 18 ? null : bundled ? 'Reinstall TonePilot.' : 'Install Node.js 18 or newer, or use a build that bundles Node.'));

  const app = lightroomApp();
  checks.push(check('lightroom-installed', app, 'Lightroom Classic installed', app || 'Not found',
    app ? null : 'Install Adobe Lightroom Classic.'));
  const running = run('/usr/bin/pgrep', ['-x', 'Adobe Lightroom Classic']).status === 0;
  checks.push(check('lightroom-running', running, 'Lightroom Classic running', running ? 'Running' : 'Not running',
    running ? null : 'Open Lightroom Classic with the catalog you want to edit.'));

  // TonePilot's own plug-in, when running, replaces the MCP bridge; the MCP checks then
  // become recommendations only.
  let own = null;
  try { own = JSON.parse(fs.readFileSync(bridgeFile(), 'utf8')); } catch { /* not installed or never started */ }
  const ownListening = !!own && /LISTEN/.test(run('/usr/sbin/lsof', ['-nP', '-iTCP:' + Number(own.requestPort), '-sTCP:LISTEN']).stdout || '');
  // Shown only once installed: it isn't verified inside Lightroom yet, so setup doesn't ask for it.
  if (own) checks.push(check('tonepilot-plugin', ownListening, 'TonePilot Lightroom plug-in', ownListening ? 'Listening (version ' + (own.plugin || '?') + ')' : 'Not running',
    ownListening ? null : 'Restart Lightroom Classic; until then the Lightroom MCP bridge is used.', 'recommended'));
  const mcpSeverity = ownListening ? 'recommended' : 'required';

  const version = pluginVersion();
  checks.push(check('plugin', version, 'Lightroom MCP plug-in', version ? 'Version ' + version : 'Not installed',
    version ? null : 'Install the Lightroom MCP plug-in (github.com/Automaat/lightroom-mcp), then enable it in File → Plug-in Manager.', mcpSeverity));
  if (version) {
    checks.push(check('plugin-version', version === TESTED_BRIDGE_VERSION, 'Plug-in version verified',
      version === TESTED_BRIDGE_VERSION ? 'Matches the tested version' : 'Installed ' + version + '; TonePilot was verified with ' + TESTED_BRIDGE_VERSION,
      version === TESTED_BRIDGE_VERSION ? null : 'Install plug-in version ' + TESTED_BRIDGE_VERSION + ' or proceed with care.', 'recommended'));
  }
  const listening = /LISTEN/.test(run('/usr/sbin/lsof', ['-nP', '-iTCP:58763', '-sTCP:LISTEN']).stdout || '');
  checks.push(check('plugin-server', listening, 'Plug-in server listening', listening ? 'Port 58763' : 'Not listening',
    listening ? null : 'In Lightroom: File → Plug-in Manager → Lightroom MCP → Start Server.', mcpSeverity));
  const server = bridgeServer();
  checks.push(check('bridge-server', server.ok, 'Bridge server ' + TESTED_BRIDGE_VERSION, server.where,
    server.ok ? null : 'Connect to the internet once so the pinned bridge can be downloaded, or use a bundled build.', 'recommended'));

  checks.push(...await aiChecks(process.env, live));

  const analyzer = process.env.TONEPILOT_ANALYZER;
  const st = analyzer && fs.existsSync(analyzer) ? run(analyzer, ['--selftest'], 20000) : null;
  checks.push(check('analyzer', st?.status === 0, 'On-device measurements', st?.status === 0 ? 'Self-test passed' : analyzer ? 'Self-test failed' : 'Not bundled',
    st?.status === 0 ? null : 'Rebuild TonePilot; without measurements TonePilot falls back to per-photo AI judgments.', 'recommended'));

  const runs = process.env.TONEPILOT_RUNS_DIR;
  let writable = false;
  try { fs.mkdirSync(runs, {recursive: true, mode: 0o700}); fs.accessSync(runs, fs.constants.W_OK); writable = true; } catch { /* reported below */ }
  checks.push(check('storage', writable, 'Session records', writable ? 'Private folder ready' : 'Not writable',
    writable ? null : 'Check permissions on ~/Library/Application Support/TonePilot.'));

  if (live && running && (listening || ownListening)) {
    let detail, ok = false, client = null;
    try {
      client = await connectLightroom();
      const sel = await readSelection(client, 1);
      ok = true;
      detail = (client.kind === 'tonepilot' ? 'TonePilot plug-in ' : 'Bridge ') + (client.serverInfo?.version || '?') + ' answered; ' + sel.count + ' photo' + (sel.count === 1 ? '' : 's') + ' selected';
      const relative = !!client.writableKeys?.has('IncrementalTemperature') && !!client.writableKeys?.has('IncrementalTint');
      checks.push(check('relative-wb', relative, 'White balance on JPEG, HEIC and TIFF',
        relative ? 'The bridge can read and write Lightroom\'s relative white balance' : 'The installed bridge can only change white balance on RAW files',
        relative ? null : 'iPhone and other JPEG/HEIC photos need a bridge that supports Lightroom\'s IncrementalTemperature/IncrementalTint. RAW files are not affected.',
        'recommended'));
    } catch (e) { detail = e.message; }
    finally { await client?.close(); }
    checks.push(check('live-bridge', ok, 'Live Lightroom connection', detail,
      ok ? null : 'Restart the plug-in server in Lightroom’s Plug-in Manager and try again.'));
  }
  const ready = checks.filter(c => c.severity === 'required').every(c => c.ok);
  return {ready, checks};
}
