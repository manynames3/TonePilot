// Claude providers for the read-only assessment: Amazon Bedrock (AWS credentials from the
// standard chain, or a Bedrock API key) and the Anthropic API (API key). Same prompt and
// schema as the Codex path; the answer is constrained by structured outputs.
import Anthropic from '@anthropic-ai/sdk';
import AnthropicBedrock, {AnthropicBedrockMantle} from '@anthropic-ai/bedrock-sdk';

export const DEFAULT_MODELS = {bedrock: 'anthropic.claude-opus-5-5', anthropic: 'claude-opus-5-5'};

// Structured outputs accept no numeric, length or item-count constraints; normalizeAssessment
// and assessBatch check those on the answer instead.
const UNSUPPORTED = new Set(['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
export function outputSchema(schema) {
  if (Array.isArray(schema)) return schema.map(outputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, outputSchema(v)]));
}

// Bedrock serves Claude two ways. Opus 4.7 and later: the Messages endpoint, IDs like
// anthropic.claude-opus-5-5. Earlier models (Sonnet 4.5/4.6, Haiku 4.5, Opus 4.6…): the
// classic InvokeModel endpoint through an inference profile, IDs like
// us.anthropic.claude-sonnet-4-6 — and an account may only have access to those.
export const isClassicBedrock = model => /^(us|eu|apac|jp|au|global)\.anthropic\.|^arn:aws/.test(model);

// The one place a Claude client is configured; the assessment and doctor's live check share it.
export function claudeClient(name, env = process.env) {
  const model = env.TONEPILOT_AI_MODEL || DEFAULT_MODELS[name];
  const baseURL = env.TONEPILOT_AI_BASE_URL || undefined;   // tests: a local mock of the Messages API
  // It disables Bedrock signing and receives the API key, so it may only point at this machine.
  if (baseURL && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname))
    throw new Error('TONEPILOT_AI_BASE_URL is only for local tests');
  const region = env.TONEPILOT_AWS_REGION || env.AWS_REGION || 'us-east-1';
  if (name === 'bedrock' && isClassicBedrock(model)) {
    // The classic client reads the profile from the standard credential chain.
    if (env.TONEPILOT_AWS_PROFILE && env === process.env) process.env.AWS_PROFILE = env.TONEPILOT_AWS_PROFILE;
    return {client: new AnthropicBedrock({awsRegion: region, baseURL, skipAuth: !!baseURL}), model, classic: true};
  }
  const client = name === 'bedrock'
    ? new AnthropicBedrockMantle({awsRegion: region,
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

// maxTokens bounds what one call can cost (thinking counts toward it); TonePilot Cloud sets
// a smaller one than a photographer's own account.
export function claudeProvider(name, env = process.env, {maxTokens = 16000} = {}) {
  const {client, model, classic} = claudeClient(name, env);
  const effort = env.TONEPILOT_AI_EFFORT || 'medium';

  return {name, model, async run({jpegs, prompt, schema, timeoutMs, signal}) {
    const started = Date.now();
    // Current models: structured outputs. Classic Bedrock models: the same schema as a tool
    // the model must call (they predate structured outputs and effort).
    const answerFormat = classic
      ? {tools: [{name: 'assessment', description: 'Return the assessment.', input_schema: outputSchema(schema)}],
          tool_choice: {type: 'tool', name: 'assessment'}}
      : {output_config: {effort, format: {type: 'json_schema', schema: outputSchema(schema)}}};
    const response = await client.messages.create({
      model, max_tokens: classic ? Math.min(maxTokens, 4000) : maxTokens, ...answerFormat,
      messages: [{role: 'user', content: [
        ...jpegs.map(jpeg => ({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64')}})),
        {type: 'text', text: prompt}]}]
    }, {timeout: timeoutMs, maxRetries: 0, signal});   // one attempt per deadline; the engine retries on resume
    // A refusal or a cut-off answer is not an assessment; the photo is flagged like any AI failure.
    if (response.stop_reason === 'refusal') throw new Error('AI declined to assess this photo');
    if (response.stop_reason === 'max_tokens') throw new Error('AI answer was cut off');
    const raw = classic ? response.content.find(block => block.type === 'tool_use')?.input
      : JSON.parse(response.content.find(block => block.type === 'text')?.text || 'null');
    if (!raw) throw new Error('AI returned no assessment');
    return {raw, stats: {ms: Date.now() - started,
      inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null}};
  }};
}
