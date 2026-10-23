// The assessment providers: the Codex CLI, Claude on Amazon Bedrock and Claude through the
// Anthropic API run the same prompt and schema and must lead to the same journal and
// decisions. The Claude providers run against a local fake of the Messages API; nothing
// here reaches AWS or Anthropic.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup, rawPhoto} from './helpers.mjs';
import {outputSchema} from '../Engine/claude.mjs';
import {ASSESSMENT_SCHEMA, batchSchema} from '../Engine/ai.mjs';

const THREE = () => ({101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3'), 103: rawPhoto('C.CR3')});
const IDS = ['101', '102', '103'];
const decisions = x => dir => x.show(dir).photos.map(p => [p.id, p.state, JSON.stringify(p.changes)]);

test('Claude on Bedrock and through the Anthropic API reach the same decisions as Codex', () => {
  const results = {};
  for (const provider of ['codex', 'bedrock', 'anthropic']) {
    const x = setup({provider, photos: THREE()});
    try {
      const dir = x.analyze(IDS);
      results[provider] = decisions(x)(dir);
      const stats = x.journal(dir).filter(r => r.type === 'photo-assessed').map(r => r.stats);
      assert.equal(stats.length, 3);
      assert.ok(stats.every(s => s.provider === provider && s.batch === 1 && s.inputTokens > 0), provider + ' is journaled per photo');
      if (provider === 'codex') continue;
      const calls = x.claudeCalls();
      assert.equal(calls.length, 3, 'one call per photo');
      assert.ok(calls.every(c => c.images === 1 && c.effort === 'medium' && c.schemaOk));
      assert.deepEqual([...new Set(calls.map(c => c.model))], [provider === 'bedrock' ? 'anthropic.claude-opus-5-5' : 'claude-opus-5-5']);
      assert.deepEqual([...new Set(stats.map(s => s.model))], [calls[0].model]);
      assert.equal(calls[0].apiKey, provider === 'anthropic' ? 'sk-ant-test-key' : null, 'only the Anthropic API gets the key');
    } finally { x.cleanup(); }
  }
  assert.deepEqual(results.bedrock, results.codex);
  assert.deepEqual(results.anthropic, results.codex);
  assert.ok(results.codex.every(([, state]) => state === 'proposed'));
});

test('a scene batch is one Claude call with every preview, and the model can be chosen', () => {
  const x = setup({provider: 'bedrock', photos: THREE()});
  try {
    const r = x.run(['--mode', 'analyze', '--ids', JSON.stringify(IDS)], {TONEPILOT_AI_BATCH: '3', TONEPILOT_AI_MODEL: 'anthropic.claude-sonnet-5-5'});
    assert.equal(r.status, 0, JSON.stringify(r.error));
    assert.deepEqual(x.claudeCalls().map(c => [c.images, c.model]), [[3, 'anthropic.claude-sonnet-5-5']]);
    assert.ok(x.show(r.complete.dir).photos.every(p => p.state === 'proposed'));
  } finally { x.cleanup(); }
});

test('a Claude refusal or error is an AI failure: the analysis stops resumably, nothing is guessed', () => {
  const x = setup({provider: 'bedrock', photos: THREE()});
  try {
    x.set(s => { s.claudeRefusal = true; });
    const r = x.run(['--mode', 'analyze', '--ids', JSON.stringify(IDS)]);
    assert.notEqual(r.status, 0);
    assert.match(r.error.message, /failed for every photo \(AI declined/);
    const dir = r.events.find(e => e.type === 'session').dir;
    x.set(s => { s.claudeRefusal = false; s.aiFail = ['103']; });
    assert.equal(x.run(['--mode', 'analyze', '--resume', dir]).status, 0);
    assert.deepEqual(x.show(dir).photos.map(p => p.state), ['proposed', 'proposed', 'flagged']);
  } finally { x.cleanup(); }
});

test('the schema sent to Claude drops only the constraints structured outputs reject', () => {
  for (const schema of [ASSESSMENT_SCHEMA, batchSchema(4)]) {
    const sent = JSON.stringify(outputSchema(schema));
    assert.doesNotMatch(sent, /"(minimum|maximum|minLength|maxLength|minItems|maxItems)"/);
    const kept = s => JSON.stringify(s).match(/"(enum|required|additionalProperties)"/g).length;
    assert.equal(kept(outputSchema(schema)), kept(schema), 'enums, required fields and closed objects are kept');
  }
});

test('an unknown provider is refused before any photo is assessed', () => {
  const x = setup({photos: THREE()});
  try {
    const r = x.run(['--mode', 'analyze', '--ids', JSON.stringify(IDS)], {TONEPILOT_AI_PROVIDER: 'mystery'});
    assert.notEqual(r.status, 0);
    assert.match(r.error.message, /Unknown AI provider: mystery/);
  } finally { x.cleanup(); }
});

test('compare-providers runs each provider read-only and reports agreement, repeatability, tokens and cost', async () => {
  const {spawnSync} = await import('node:child_process');
  const {join} = await import('node:path');
  const x = setup({provider: 'bedrock', photos: THREE()});
  try {
    const out = join(x.temp, 'compare');
    const r = spawnSync(process.execPath, [new URL('../Benchmarks/compare-providers.mjs', import.meta.url).pathname, 'run',
      '--ids', JSON.stringify(IDS), '--runs', '2', '--out', out, '--try', 'codex', '--try', 'bedrock:anthropic.claude-sonnet-5-5',
      '--price', 'anthropic.claude-sonnet-5-5=2,10'], {env: x.env, encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.baseline, 'codex:codex');
    const [codex, sonnet] = report.rows;
    assert.deepEqual([codex.runs, codex.photosAssessed, codex.repeatability.decisions], [2, 6, 1]);
    assert.equal(sonnet.provider, 'bedrock:anthropic.claude-sonnet-5-5');
    assert.equal(sonnet.agreementWith.decisions, 1);
    assert.equal(sonnet.inputTokensPerPhoto, 4000);   // the fake API's usage: 2500 per image + 1500
    assert.equal(sonnet.usdPerPhoto, (4000 * 2 + 150 * 10) / 1e6);
    assert.equal(codex.usdPerPhoto, null, 'no price given, none assumed');
    assert.equal(x.get().writes.length, 0, 'read-only');
  } finally { x.cleanup(); }
});
