#!/usr/bin/env node
// Which AI provider and model should TonePilot use? Analyze the same photos with each one
// (read-only: analyze never writes to Lightroom) and compare decisions, repeatability,
// tokens, time and cost. Agreement is NOT quality — a model can agree with Codex and
// still be wrong; quality needs the blind evaluation (evaluate.mjs). This answers the
// cheaper questions first: does a model decide like the current one, how stable is it,
// and what does it cost per photo.
//
//   Run (needs the selected photos in Lightroom and each provider's credentials):
//     node compare-providers.mjs run --ids '["123","456"]' --runs 2 --out <scratch-dir> \
//       --try codex:gpt-6.1-sol@low --try codex:gpt-6-luna@xhigh --try bedrock:anthropic.claude-sonnet-5-5
//   Report on existing sessions (grouped by the provider and model in their journals):
//     node compare-providers.mjs report <session-dir> [...] [--price anthropic.claude-opus-5-5=4,20]
//
// --price model=input,output is USD per million tokens, as quoted to you; nothing is assumed.
// Session folders hold descriptions of client photos: keep --out in a scratch folder and
// delete it afterwards.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadSession} from '../Engine/session.mjs';
import {repeatability} from './repeatability.mjs';

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const keyOf = s => {
  const stats = s.order.map(id => s.photos[id].aiStats).find(Boolean);
  return stats ? (stats.provider || 'codex') + ':' + (stats.model || 'codex') : 'unknown';
};

export function compare(sessions, prices = {}) {
  const groups = new Map();
  for (const s of sessions) groups.set(keyOf(s), [...(groups.get(keyOf(s)) || []), s]);
  const [baselineKey] = groups.keys();
  const baseline = groups.get(baselineKey)[0];
  const rows = [...groups].map(([key, runs]) => {
    const stats = runs.flatMap(s => s.order.map(id => s.photos[id].aiStats).filter(Boolean));
    const input = mean(stats.map(x => x.inputTokens).filter(Number.isFinite));
    const output = mean(stats.map(x => x.outputTokens).filter(Number.isFinite));
    const price = prices[key.split(':').slice(1).join(':')];
    return {provider: key, runs: runs.length, photosAssessed: stats.length,
      failures: runs.reduce((n, s) => n + s.order.filter(id => s.photos[id].aiError).length, 0),
      inputTokensPerPhoto: input && Math.round(input), outputTokensPerPhoto: output && Math.round(output),
      secondsPerPhoto: mean(stats.map(x => x.ms).filter(Number.isFinite)) / 1000,
      usdPerPhoto: price && input != null ? (input * price[0] + output * price[1]) / 1e6 : null,
      repeatability: runs.length > 1 ? pick(repeatability(runs)) : null,
      agreementWith: key === baselineKey ? null : {baseline: baselineKey, ...pick(repeatability([baseline, runs[0]]))}};
  });
  return {baseline: baselineKey, rows};
}
const pick = r => ({photos: r.photos, decisions: r.decisionAgreement, settings: r.settingAgreement, judgments: r.judgmentAgreement});

function run({ids, runs, out, tries}) {
  const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Engine/engine.mjs');
  const dirs = [];
  for (const t of tries) {
    const [provider, ...model] = t.split(':');
    for (let i = 0; i < runs; i++) {
      const env = {...process.env, TONEPILOT_RUNS_DIR: out, TONEPILOT_AI_PROVIDER: provider};
      // provider:model@effort — e.g. codex:gpt-6-luna@xhigh, bedrock:anthropic.claude-sonnet-5-5
      const [modelId, effort] = model.join(':').split('@');
      if (modelId) env.TONEPILOT_AI_MODEL = modelId; else delete env.TONEPILOT_AI_MODEL;
      if (effort) env.TONEPILOT_AI_EFFORT = effort; else delete env.TONEPILOT_AI_EFFORT;
      const r = spawnSync(process.execPath, [engine, '--mode', 'analyze', '--ids', ids], {env, encoding: 'utf8', timeout: 30 * 60000});
      const complete = (r.stdout || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(e => e.type === 'complete');
      if (!complete) { console.error(t + ' run ' + (i + 1) + ' failed: ' + (r.stdout || '').trim().split('\n').pop()); continue; }
      dirs.push(complete.dir);
      console.error(t + ' run ' + (i + 1) + ': ' + complete.dir);
    }
  }
  return dirs;
}

if (import.meta.url === 'file://' + path.resolve(process.argv[1] || '')) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = (name) => rest.flatMap((a, i) => (a === '--' + name ? [rest[i + 1]] : []));
  const prices = Object.fromEntries(opts('price').map(p => { const [m, v] = p.split('='); return [m, v.split(',').map(Number)]; }));
  let dirs;
  if (cmd === 'run') {
    const [ids] = opts('ids'), [out] = opts('out'), tries = opts('try');
    if (!ids || !out || !tries.length) { console.error('Usage: compare-providers.mjs run --ids <json> --out <dir> --try <provider[:model]> ... [--runs N]'); process.exit(2); }
    fs.mkdirSync(out, {recursive: true, mode: 0o700});
    dirs = run({ids, runs: Number(opts('runs')[0] || 1), out: path.resolve(out), tries});
  } else if (cmd === 'report') {
    dirs = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--'));
  } else { console.error('Usage: compare-providers.mjs run|report …'); process.exit(2); }
  const sessions = dirs.map(d => loadSession(path.resolve(d))).filter(Boolean);
  if (!sessions.length) { console.error('No sessions to compare'); process.exit(1); }
  console.log(JSON.stringify(compare(sessions, prices), null, 2));
}
