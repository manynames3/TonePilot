// AI and AWS credentials are for the engine's own model calls. No child process — the
// Lightroom bridge, the Codex CLI, the analyzer, system tools — needs them, so none gets them.
const SECRETS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AWS_BEARER_TOKEN_BEDROCK|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_CONTAINER_.*|TONEPILOT_LICENSE)$/;
export const childEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRETS.test(k)));
