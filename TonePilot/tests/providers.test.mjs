// The assessment providers: the Codex CLI, Claude on Amazon Bedrock and Claude through the
// Anthropic API run the same prompt and schema and must lead to the same journal and
// decisions. The Claude providers run against a local fake of the Messages API; nothing
// here reaches AWS or Anthropic.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
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

// No AWS settings from the machine running the tests: credentials only from what each case sets.
const noAWS = x => ({AWS_SHARED_CREDENTIALS_FILE: join(x.temp, 'aws-credentials'), AWS_CONFIG_FILE: join(x.temp, 'aws-config'),
  AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_PROFILE: '', AWS_REGION: '', AWS_BEARER_TOKEN_BEDROCK: '', TONEPILOT_AWS_PROFILE: ''});
const doctor = (x, env, live = true) => {
  const r = x.run(['--mode', 'doctor', ...(live ? ['--live'] : [])], {...noAWS(x), ...env});
  assert.equal(r.status, 0, r.stderr);
  return {checks: Object.fromEntries(r.complete.checks.map(c => [c.id, c])), out: JSON.stringify(r.events)};
};

test('doctor checks only the selected AI service; the live check is one tiny call and no secret is printed', () => {
  const codex = setup();
  try {
    const {checks} = doctor(codex, {});
    assert.ok(checks.codex && !checks['ai-credentials'] && !checks['ai-live'], 'Codex keeps its own checks');
  } finally { codex.cleanup(); }

  const x = setup({provider: 'bedrock'});
  try {
    let {checks} = doctor(x, {});
    assert.equal(checks['ai-credentials'].ok, false);
    assert.match(checks['ai-credentials'].fix, /Bedrock API key/);
    assert.ok(!checks['ai-live'] && !checks.codex && !checks['codex-auth'], 'no live call without credentials; Codex is not required');
    assert.equal(x.claudeCalls().length, 0);

    const token = 'bedrock-secret-token-9731';
    const r = doctor(x, {AWS_BEARER_TOKEN_BEDROCK: token, TONEPILOT_AWS_REGION: 'eu-central-1'});
    checks = r.checks;
    assert.deepEqual([checks['ai-credentials'].detail, checks['ai-region'].detail], ['Bedrock API key', 'eu-central-1']);
    assert.equal(checks['ai-live'].ok, true);
    assert.match(checks['ai-live'].detail, /^anthropic\.claude-opus-5-5 answered in \d+ ms$/);
    assert.ok(['ai-credentials', 'ai-region', 'ai-live'].every(id => checks[id].severity === 'required'));
    assert.doesNotMatch(r.out, /9731/);
    assert.deepEqual(x.claudeCalls(), [{ping: true, model: 'anthropic.claude-opus-5-5', maxTokens: 16, apiKey: null}]);

    writeFileSync(join(x.temp, 'aws-config'), '[default]\nregion = us-east-1\n[profile studio]\nsso_session = x\n');
    assert.equal(doctor(x, {TONEPILOT_AWS_PROFILE: 'studio'}, false).checks['ai-credentials'].detail, 'AWS profile “studio” (~/.aws)');
    assert.equal(doctor(x, {}, false).checks['ai-credentials'].detail, 'AWS profile “default” (~/.aws)');
    assert.equal(doctor(x, {TONEPILOT_AWS_PROFILE: 'missing', AWS_BEARER_TOKEN_BEDROCK: token}, false).checks['ai-credentials'].ok, false,
      'a named profile wins over the key, as in the SDK');
    assert.equal(doctor(x, {AWS_BEARER_TOKEN_BEDROCK: token, TONEPILOT_AWS_REGION: 'mars'}, false).checks['ai-region'].ok, false);

    const down = doctor(x, {AWS_BEARER_TOKEN_BEDROCK: token, TONEPILOT_AI_BASE_URL: 'http://127.0.0.1:9'}).checks['ai-live'];
    assert.equal(down.ok, false);
    assert.ok(down.fix);
  } finally { x.cleanup(); }

  const a = setup({provider: 'anthropic'});
  try {
    const r = doctor(a, {TONEPILOT_AI_MODEL: 'claude-haiku-5-5'});
    assert.equal(r.checks['ai-credentials'].detail, 'Saved, ending in -key');
    assert.doesNotMatch(r.out, /sk-ant-test-key/);
    assert.equal(r.checks['ai-live'].ok, true);
    assert.deepEqual(a.claudeCalls(), [{ping: true, model: 'claude-haiku-5-5', maxTokens: 16, apiKey: 'sk-ant-test-key'}]);
    assert.equal(doctor(a, {ANTHROPIC_API_KEY: ''}).checks['ai-credentials'].ok, false);
  } finally { a.cleanup(); }
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

test('no helper process (bridge, Codex CLI, analyzer) ever sees an AI or AWS secret', async () => {
  const {existsSync, readFileSync} = await import('node:fs');
  const secrets = {AWS_BEARER_TOKEN_BEDROCK: 'bedrock-test-key', AWS_SECRET_ACCESS_KEY: 'aws-test-secret', TONEPILOT_LICENSE: 'tp1.test',
    ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_AUTH_TOKEN: 'oauth-test'};
  for (const provider of ['anthropic', 'codex']) {
    const x = setup({provider, photos: THREE()});
    try {
      assert.equal(x.run(['--mode', 'analyze', '--ids', JSON.stringify(IDS)], secrets).status, 0);
      x.run(['--mode', 'doctor'], {...secrets, TONEPILOT_AI_PROVIDER: 'codex'});
      const leaked = x.state + '.child-secrets';
      assert.ok(!existsSync(leaked), provider + ': ' + (existsSync(leaked) ? readFileSync(leaked, 'utf8') : ''));
    } finally { x.cleanup(); }
  }
});

test('a Claude call is made once: no hidden SDK retries stretch the time limit', () => {
  const x = setup({provider: 'bedrock', photos: THREE()});
  try {
    x.set(s => { s.claudeStatus = 529; });
    const r = x.run(['--mode', 'analyze', '--ids', JSON.stringify(IDS)]);
    assert.notEqual(r.status, 0);
    assert.equal(x.claudeCalls().length, 3, 'one request per photo, not three');
  } finally { x.cleanup(); }
});

test('Stop cancels a Claude request in flight instead of waiting for it', async () => {
  const x = setup({provider: 'bedrock', photos: THREE()});
  try {
    x.set(s => { s.aiDelayMs = 60000; });
    const child = x.start(['--mode', 'analyze', '--ids', JSON.stringify(IDS)]);
    const exited = new Promise(resolve => child.on('exit', resolve));
    for (let i = 0; i < 200 && !x.claudeCalls().length; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(x.claudeCalls().length, 'a request is in flight');
    const stoppedAt = Date.now();
    child.kill('SIGTERM');
    await exited;
    assert.ok(Date.now() - stoppedAt < 5000, 'stopped in ' + (Date.now() - stoppedAt) + ' ms');
  } finally { x.cleanup(); }
});

test('the test-only Messages API address is honoured only on this machine', async () => {
  const {claudeClient} = await import('../Engine/claude.mjs');
  assert.throws(() => claudeClient('anthropic', {ANTHROPIC_API_KEY: 'k', TONEPILOT_AI_BASE_URL: 'https://api.example.com'}), /only for local tests/);
  assert.throws(() => claudeClient('bedrock', {TONEPILOT_AI_BASE_URL: 'http://10.0.0.5:8080'}), /only for local tests/);
  assert.ok(claudeClient('bedrock', {TONEPILOT_AI_BASE_URL: 'http://127.0.0.1:9'}).client);
});

test('doctor checks TonePilot Cloud by its address and license, and calls no Claude API for it', () => {
  const x = setup();
  try {
    const now = Math.floor(Date.now() / 1000);
    const checks = env => x.run(['--mode', 'doctor', '--live'], {TONEPILOT_AI_PROVIDER: 'cloud', ANTHROPIC_API_KEY: 'sk-ant-should-not-be-used',
      TONEPILOT_AI_BASE_URL: '', ...env}).complete.checks.filter(c => c.id.startsWith('ai') || c.id.startsWith('cloud'));
    const ok = checks({TONEPILOT_CLOUD_URL: 'https://api.tonepilot.example', TONEPILOT_LICENSE: 'tp1.lic_1.' + (now + 86400) + '.sig'});
    assert.ok(ok.length && ok.every(c => c.ok), JSON.stringify(ok));
    assert.ok(!ok.some(c => /Anthropic/.test(c.title + c.detail)), 'no Anthropic key check for Cloud');
    assert.ok(!JSON.stringify(ok).includes('sig'), 'the license is never printed');
    const bad = checks({TONEPILOT_CLOUD_URL: 'http://api.tonepilot.example', TONEPILOT_LICENSE: 'tp1.lic_1.' + (now - 60) + '.sig'});
    assert.deepEqual(bad.filter(c => !c.ok).map(c => c.id).sort(), ['cloud-license', 'cloud-url']);
    assert.equal(x.claudeCalls().length, 0);
  } finally { x.cleanup(); }
});

test('classic Bedrock models (inference profiles such as us.anthropic.claude-sonnet-4-6) get the schema as a forced tool', () => {
  const x = setup({provider: 'bedrock', photos: THREE()});
  try {
    const r = x.run(['--mode', 'analyze', '--ids', JSON.stringify(IDS)], {TONEPILOT_AI_MODEL: 'us.anthropic.claude-sonnet-4-6'});
    assert.equal(r.status, 0, JSON.stringify(r.error));
    const calls = x.claudeCalls();
    assert.ok(calls.length === 3 && calls.every(c => c.classic && c.schemaOk && c.model === 'us.anthropic.claude-sonnet-4-6' && c.effort === undefined));
    assert.ok(x.show(r.complete.dir).photos.every(p => p.state === 'proposed'));
  } finally { x.cleanup(); }
});
