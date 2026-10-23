// Shared harness: an isolated runs folder, a mock Lightroom state file and helpers
// to run the real engine against them. Never touches a real catalog: the bridge file the
// engine looks for is always inside the test's temp folder.
import {mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, readdirSync, existsSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync, spawn} from 'node:child_process';
import {test} from 'node:test';
import {signLicense} from '../Cloud/license.mjs';
import {TEST_SECRET} from './mock-cloud.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
export const ENGINE = resolve(folder, '../Engine/engine.mjs');
const MOCK_MCP = resolve(folder, 'mock-lightroom.mjs');
const MOCK_PLUGIN = resolve(folder, 'mock-plugin.mjs');
const MOCK_MODEL = resolve(folder, 'mock-model.mjs');
const MOCK_ANALYZER = resolve(folder, 'mock-analyzer.mjs');
const MOCK_CLAUDE = resolve(folder, 'mock-claude.mjs');
const MOCK_CLOUD = resolve(folder, 'mock-cloud.mjs');
for (const f of [MOCK_MODEL, MOCK_ANALYZER, MOCK_MCP]) chmodSync(f, 0o755);

// The Lightroom bridges the workflow and recovery suites run against: the third-party MCP
// bridge, and TonePilot's own plug-in.
const BRIDGES = ['mcp', 'tonepilot'];
// Registers one test per bridge; fn receives the bridge name to pass to setup().
export function eachBridge(name, fn) {
  for (const bridge of BRIDGES) test(name + ' [' + bridge + ']', () => fn(bridge));
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Starts the fake TonePilot plug-in and waits (synchronously) for its bridge file.
function startPlugin(env) {
  const server = spawn(process.execPath, [MOCK_PLUGIN], {env, stdio: ['pipe', 'ignore', 'inherit']});
  for (let i = 0; i < 250 && !existsSync(env.TONEPILOT_BRIDGE_FILE); i++) pause(20);
  if (!existsSync(env.TONEPILOT_BRIDGE_FILE)) { server.kill(); throw new Error('mock plug-in did not start'); }
  return server;
}

// Starts a fake AI service (a script that writes its port to <state>.port) and waits for it.
function startService(script, env, portVar, name) {
  env[portVar] = env.TONEPILOT_MOCK_STATE + '.port';
  const server = spawn(process.execPath, [script], {env, stdio: ['pipe', 'ignore', 'inherit']});
  for (let i = 0; i < 250 && !existsSync(env[portVar]); i++) pause(20);
  if (!existsSync(env[portVar])) { server.kill(); throw new Error(name + ' did not start'); }
  return {server, url: 'http://127.0.0.1:' + readFileSync(env[portVar], 'utf8')};
}

// The fake Messages API for the Claude providers, or TonePilot Cloud's real handler in front
// of the fake model, with the engine pointed at it.
function startAI(env, provider) {
  if (provider === 'cloud') {
    const {server, url} = startService(MOCK_CLOUD, env, 'TONEPILOT_MOCK_CLOUD_PORT', 'local TonePilot Cloud');
    const expires = Math.floor(Date.now() / 1000) + 3600;
    Object.assign(env, {TONEPILOT_AI_PROVIDER: 'cloud', TONEPILOT_CLOUD_URL: url, TONEPILOT_LICENSE: signLicense('test-license', expires, TEST_SECRET)});
    return server;
  }
  const {server, url} = startService(MOCK_CLAUDE, env, 'TONEPILOT_MOCK_CLAUDE_PORT', 'mock Messages API');
  Object.assign(env, {TONEPILOT_AI_PROVIDER: provider, TONEPILOT_AI_BASE_URL: url,
    ANTHROPIC_API_KEY: provider === 'anthropic' ? 'sk-ant-test-key' : ''});
  return server;
}

export function rawPhoto(filename, overrides = {}) {
  return {
    filename, path: '/Volumes/Test/' + filename, fileFormat: 'RAW', dateTimeOriginal: '2026-06-01 15:00:00',
    asShot: {temperature: 5200, tint: 4},
    settings: {whiteBalance: 'As Shot', temperature: 5200, tint: 4, exposure: 0, contrast: 0,
      highlights: 0, shadows: 0, whites: 0, blacks: 0, clarity: 0},
    metrics: {faceLuma: 0.12, atExposure: 0, clip: 0.001},
    ...overrides
  };
}

export function setup({photos, selected, faults = {}, ai = {}, extra = {}, bridge = 'mcp', provider = 'codex'} = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'tonepilot-test-'));
  const state = join(temp, 'state.json');
  const runs = join(temp, 'runs');
  photos ||= {101: rawPhoto('A_0101.CR3')};
  writeFileSync(state, JSON.stringify({selected: selected || Object.keys(photos), writes: [], photos, faults, ai, ...extra}));
  const env = {...process.env, TONEPILOT_NPX: process.execPath, TONEPILOT_MCP_ARGS: JSON.stringify([MOCK_MCP]),
    TONEPILOT_MOCK_STATE: state, TONEPILOT_CODEX: MOCK_MODEL, TONEPILOT_ANALYZER: MOCK_ANALYZER,
    TONEPILOT_RUNS_DIR: runs, TONEPILOT_SETTLE_MS: '0', TONEPILOT_WRITE_TIMEOUT_MS: '800', TONEPILOT_PREVIEW_RETRY_MS: '0',
    TONEPILOT_BRIDGE_FILE: join(temp, 'bridge.json')};
  const plugin = bridge === 'tonepilot' ? startPlugin(env) : null;
  const service = provider !== 'codex' ? startAI(env, provider) : null;
  const parse = out => out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {type: 'raw', line: l}; } });
  const run = (args, envExtra = {}) => {
    const r = spawnSync(process.execPath, [ENGINE, ...args], {env: {...env, ...envExtra}, encoding: 'utf8', timeout: 30000});
    const events = parse(r.stdout || '');
    return {status: r.status, signal: r.signal, events, stderr: r.stderr,
      complete: events.find(e => e.type === 'complete'), error: events.find(e => e.type === 'error')};
  };
  const start = (args, envExtra = {}) => spawn(process.execPath, [ENGINE, ...args], {env: {...env, ...envExtra}, stdio: ['ignore', 'pipe', 'pipe']});
  const get = () => JSON.parse(readFileSync(state, 'utf8'));
  const set = fn => { const s = get(); fn(s); writeFileSync(state, JSON.stringify(s)); };
  const show = dir => run(['--mode', 'show', '--session', dir]).complete.session;
  const journal = dir => readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const analyze = (ids, extraArgs = []) => {
    const r = run(['--mode', 'analyze', '--ids', JSON.stringify(ids), ...extraArgs]);
    if (r.status !== 0) throw new Error('analyze failed: ' + JSON.stringify(r.error) + r.stderr);
    return r.complete.dir;
  };
  const sessions = () => readdirSync(runs).filter(n => n.startsWith('session-'));
  const cleanup = () => { plugin?.kill(); service?.kill(); rmSync(temp, {recursive: true, force: true}); };
  const lines = suffix => (existsSync(state + suffix) ? readFileSync(state + suffix, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const claudeCalls = () => lines('.claude');
  const cloudLog = () => lines('.cloud');
  return {temp, state, runs, env, bridge, claudeCalls, cloudLog, run, start, get, set, show, journal, analyze, sessions, cleanup};
}
