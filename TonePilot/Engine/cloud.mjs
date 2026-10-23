// TonePilot Cloud provider: the read-only assessment through the TonePilot owner's backend
// (TonePilot/Cloud), which runs Claude on Amazon Bedrock under its own IAM role. The app holds
// only a license, never AWS credentials, and the backend picks the model and the schema
// (the same ones ai.mjs defines). Global fetch only, no dependencies.
const LOCAL = ['127.0.0.1', 'localhost', '[::1]'];

export function cloudProvider(env = process.env) {
  const base = env.TONEPILOT_CLOUD_URL, license = env.TONEPILOT_LICENSE;
  if (!base) throw new Error('TonePilot Cloud is not configured (TONEPILOT_CLOUD_URL)');
  if (!license) throw new Error('No TonePilot license (TONEPILOT_LICENSE)');
  const url = new URL('v1/assess', base.replace(/\/*$/, '/'));
  // The license is a bearer secret: plain HTTP only to this machine (tests, local runs).
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.includes(url.hostname)))
    throw new Error('TONEPILOT_CLOUD_URL must use https');

  const provider = {name: 'cloud', model: 'cloud', async run({jpegs, prompt, timeoutMs}) {
    const started = Date.now();
    let response;
    try {
      response = await fetch(url, {method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: {authorization: 'Bearer ' + license, 'content-type': 'application/json'},
        body: JSON.stringify({prompt, images: jpegs.map(jpeg => jpeg.toString('base64'))})});
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'AI assessment timed out' : 'AI service unavailable');
    }
    const body = await response.json().catch(() => null);
    if (response.status === 401) throw new Error(body?.error === 'license-expired' ? 'TonePilot license expired' : 'TonePilot license is not valid');
    // 429 is the license's daily cap, or the API's request throttling.
    if (response.status === 429) throw new Error(body?.error === 'daily-limit' ? 'Daily limit reached' : 'TonePilot Cloud is busy, try again shortly');
    if (response.status === 400) throw new Error('TonePilot Cloud refused the request');
    if (!response.ok || !body?.raw) throw new Error('AI service unavailable');
    if (typeof body.model === 'string') provider.model = body.model;   // journaled with each assessment
    return {raw: body.raw, stats: {ms: Date.now() - started,
      inputTokens: body.stats?.inputTokens ?? null, outputTokens: body.stats?.outputTokens ?? null}};
  }};
  return provider;
}
