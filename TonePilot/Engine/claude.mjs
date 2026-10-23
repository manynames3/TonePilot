// Claude providers for the read-only assessment: Amazon Bedrock (AWS credentials from the
// standard chain, or a Bedrock API key) and the Anthropic API (API key). Same prompt and
// schema as the Codex path; the answer is constrained by structured outputs.
import Anthropic from '@anthropic-ai/sdk';
import {AnthropicBedrockMantle} from '@anthropic-ai/bedrock-sdk';

export const DEFAULT_MODELS = {bedrock: 'anthropic.claude-opus-5-5', anthropic: 'claude-opus-5-5'};

// Structured outputs accept no numeric, length or item-count constraints; normalizeAssessment
// and assessBatch check those on the answer instead.
const UNSUPPORTED = new Set(['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
export function outputSchema(schema) {
  if (Array.isArray(schema)) return schema.map(outputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, outputSchema(v)]));
}

// The one place a Claude client is configured; the assessment and doctor's live check share it.
export function claudeClient(name, env = process.env) {
  const model = env.TONEPILOT_AI_MODEL || DEFAULT_MODELS[name];
  const baseURL = env.TONEPILOT_AI_BASE_URL || undefined;   // tests: a local mock of the Messages API
  const client = name === 'bedrock'
    ? new AnthropicBedrockMantle({awsRegion: env.TONEPILOT_AWS_REGION || env.AWS_REGION || 'us-east-1',
      awsProfile: env.TONEPILOT_AWS_PROFILE || undefined, baseURL, skipAuth: !!baseURL})
    : new Anthropic({apiKey: env.ANTHROPIC_API_KEY, baseURL});
  return {client, model};
}

// Doctor's live check: the smallest real call (a few tokens of text, no image) that proves
// the credentials work and the account can use the model.
export async function pingClaude(name, env = process.env, timeoutMs = 20000) {
  const {client, model} = claudeClient(name, env);
  const started = Date.now();
  await client.messages.create({model, max_tokens: 16, messages: [{role: 'user', content: [{type: 'text', text: 'Reply with OK.'}]}]},
    {timeout: timeoutMs, maxRetries: 0});
  return {model, ms: Date.now() - started};
}

export function claudeProvider(name, env = process.env) {
  const {client, model} = claudeClient(name, env);
  const effort = env.TONEPILOT_AI_EFFORT || 'medium';

  return {name, model, async run({jpegs, prompt, schema, timeoutMs}) {
    const started = Date.now();
    const response = await client.messages.create({
      model, max_tokens: 16000,
      output_config: {effort, format: {type: 'json_schema', schema: outputSchema(schema)}},
      messages: [{role: 'user', content: [
        ...jpegs.map(jpeg => ({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64')}})),
        {type: 'text', text: prompt}]}]
    }, {timeout: timeoutMs});
    // A refusal or a cut-off answer is not an assessment; the photo is flagged like any AI failure.
    if (response.stop_reason === 'refusal') throw new Error('AI declined to assess this photo');
    if (response.stop_reason === 'max_tokens') throw new Error('AI answer was cut off');
    const text = response.content.find(block => block.type === 'text')?.text;
    if (!text) throw new Error('AI returned no assessment');
    return {raw: JSON.parse(text), stats: {ms: Date.now() - started,
      inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null}};
  }};
}
