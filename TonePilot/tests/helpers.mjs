// Shared harness: an isolated runs folder, a mock Lightroom state file and helpers
// to run the real engine against them. Never touches a real catalog.
import {mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, readdirSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync, spawn} from 'node:child_process';

const folder = dirname(fileURLToPath(import.meta.url));
export const ENGINE = resolve(folder, '../Engine/engine.mjs');
const MOCK_MCP = resolve(folder, 'mock-lightroom.mjs');
const MOCK_MODEL = resolve(folder, 'mock-model.mjs');
const MOCK_ANALYZER = resolve(folder, 'mock-analyzer.mjs');
for (const f of [MOCK_MODEL, MOCK_ANALYZER, MOCK_MCP]) chmodSync(f, 0o755);

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

export function setup({photos, selected, faults = {}, ai = {}, extra = {}} = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'tonepilot-test-'));
  const state = join(temp, 'state.json');
  const runs = join(temp, 'runs');
  photos ||= {101: rawPhoto('A_0101.CR3')};
  writeFileSync(state, JSON.stringify({selected: selected || Object.keys(photos), writes: [], photos, faults, ai, ...extra}));
  const env = {...process.env, TONEPILOT_NPX: process.execPath, TONEPILOT_MCP_ARGS: JSON.stringify([MOCK_MCP]),
    TONEPILOT_MOCK_STATE: state, TONEPILOT_CODEX: MOCK_MODEL, TONEPILOT_ANALYZER: MOCK_ANALYZER,
    TONEPILOT_RUNS_DIR: runs, TONEPILOT_SETTLE_MS: '0', TONEPILOT_WRITE_TIMEOUT_MS: '800'};
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
  const cleanup = () => rmSync(temp, {recursive: true, force: true});
  return {temp, state, runs, env, run, start, get, set, show, journal, analyze, sessions, cleanup};
}
