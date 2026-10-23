// TonePilot Cloud: POST /v1/assess behind an API Gateway HTTP API (payload format 2.0).
// The app sends a prompt and 1–6 JPEG previews with its license. The SERVER picks the model
// and the output schema, so this is not a general Claude proxy: every answer is constrained
// to TonePilot's assessment schema. Zero retention: prompts, images and answers are never
// logged or stored; one log line per request holds only licenseId, image count, tokens, ms
// and status. Dependencies are injected (lambda.mjs wires the AWS ones; tests use fakes).
import {ASSESSMENT_SCHEMA, batchSchema, BATCH_SIZE} from '../Engine/ai.mjs';
import {verifyLicense} from './license.mjs';

export const LIMITS = {promptChars: 24000, images: BATCH_SIZE, imageBytes: 2 * 1024 * 1024};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const reply = (statusCode, body) => ({statusCode, body: JSON.stringify(body),
  headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});

// The request body, or null when it is not {prompt, images} within limits. Other fields
// (a model, a schema, max_tokens…) are ignored: the client cannot choose them.
function parseRequest(event) {
  let body;
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || ''); } catch { return null; }
  const {prompt, images} = body && typeof body === 'object' ? body : {};
  if (typeof prompt !== 'string' || !prompt.length || prompt.length > LIMITS.promptChars) return null;
  if (!Array.isArray(images) || !images.length || images.length > LIMITS.images) return null;
  const jpegs = [];
  for (const b64 of images) {
    if (typeof b64 !== 'string' || b64.length % 4 || b64.length > Math.ceil(LIMITS.imageBytes / 3) * 4 || !BASE64.test(b64)) return null;
    const jpeg = Buffer.from(b64, 'base64');
    if (jpeg.length < 3 || jpeg.length > LIMITS.imageBytes || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return null;
    jpegs.push(jpeg);
  }
  return {prompt, jpegs};
}

// getSecret: async () → license-signing secret. usage: {reserve, record} (atomic per-license,
// per-UTC-day photo counter). model: a provider from claude.mjs ({model, run}).
export function createHandler({getSecret, usage, model, dailyCap, timeoutMs = 25000, now = Date.now,
  log = line => console.log(JSON.stringify(line))}) {
  return async event => {
    const started = now();
    const line = {licenseId: null, images: 0, inputTokens: null, outputTokens: null, ms: 0, status: 0};
    const done = (status, body) => {
      Object.assign(line, {status, ms: now() - started});
      log(line);
      return reply(status, body);
    };
    try {
      if (event.requestContext?.http?.method !== 'POST' || event.rawPath !== '/v1/assess') return done(404, {error: 'not-found'});
      const auth = event.headers?.authorization || '';
      const license = verifyLicense(auth.startsWith('Bearer ') ? auth.slice(7) : '', await getSecret(), Math.floor(now() / 1000));
      if (license.error) return done(401, {error: license.error});
      line.licenseId = license.licenseId;

      const request = parseRequest(event);
      if (!request) return done(400, {error: 'invalid-request'});
      const {prompt, jpegs} = request;
      line.images = jpegs.length;

      // Counted before the model call, atomically against the cap: concurrent requests can't overshoot it.
      const key = {licenseId: license.licenseId, day: new Date(now()).toISOString().slice(0, 10)};
      if (!await usage.reserve({...key, photos: jpegs.length, cap: dailyCap})) return done(429, {error: 'daily-limit'});

      let result;
      try {
        result = await model.run({jpegs, prompt, schema: jpegs.length === 1 ? ASSESSMENT_SCHEMA : batchSchema(jpegs.length), timeoutMs});
      } catch {
        return done(502, {error: 'model-unavailable'});
      }
      const {ms, inputTokens = null, outputTokens = null} = result.stats || {};
      Object.assign(line, {inputTokens, outputTokens});
      // Token accounting is best effort: it never costs the photographer an answer already paid for.
      await usage.record({...key, inputTokens: inputTokens || 0, outputTokens: outputTokens || 0}).catch(() => {});
      return done(200, {raw: result.raw, model: model.model, stats: {ms, inputTokens, outputTokens}});
    } catch {
      return done(500, {error: 'server-error'});
    }
  };
}
