# TonePilot Cloud

A small AWS backend, owned by the TonePilot owner, that lets a paying photographer's app use Claude on Amazon Bedrock without any AWS credentials on the Mac. The app holds a **license**; the backend holds the IAM role.

**Status: not deployed.** Everything here is tested only locally against fakes (`TonePilot/tests/cloud.test.mjs`); see "Unverified" below.

```text
 Photographer's Mac                          TonePilot owner's AWS account
 ┌───────────────────────────┐   HTTPS   ┌─────────────────────────────────────────────┐
 │ TonePilot engine          │  POST     │ API Gateway HTTP API  (10 req/s, burst 20)  │
 │  ai.mjs ─ cloud.mjs ──────┼──────────▶│  /v1/assess                                 │
 │  license only, no AWS keys│  Bearer   └──────────────────────┬──────────────────────┘
 └───────────────────────────┘  tp1.…                           ▼
       {prompt, 1–6 JPEGs}          ┌──────────────────────────────────────────────────┐
                                    │ Lambda  (Node 22, arm64, 512 MB, 30 s)           │
                                    │  handler.mjs                                     │
                                    │  1. license: HMAC + expiry ◀── SSM SecureString  │
                                    │  2. validate prompt and JPEGs                    │
                                    │  3. reserve photos (atomic, capped) ──▶ DynamoDB │
                                    │  4. Engine/claude.mjs ──▶ Claude on Bedrock      │
                                    │     server's model + server's schema             │
                                    │  5. record tokens ──▶ DynamoDB                   │
                                    │  log: licenseId, images, tokens, ms, status      │
                                    └──────────────────────────────────────────────────┘
                                      CloudWatch logs (30 days)   AWS Budgets e-mail alerts
```

## Files

| File | Role |
|---|---|
| `handler.mjs` | The request handler; dependencies (secret, usage store, model) injected |
| `license.mjs` | License format, signing and constant-time verification |
| `lambda.mjs` | Production wiring: SSM, DynamoDB, `Engine/claude.mjs` with the function's role |
| `mint-license.mjs` | Owner-side CLI that mints a license |
| `template.yaml` | AWS SAM template |
| `stage.sh` | Lays out the Lambda package in `.build/` (handler + the reused Engine modules + pinned manifest) |
| `../Engine/cloud.mjs` | The app side: provider `cloud` |

The prompt, the output schema and the Bedrock call are the Engine's own code (`ai.mjs`, `claude.mjs`), copied into the package unchanged, not duplicated.

## Security model

- **No credentials in the app.** The app sends `Authorization: Bearer tp1.<licenseId>.<expiresUnix>.<HMAC-SHA256 base64url>`. The signing secret lives in an SSM SecureString created by the owner; the template only names it. Bedrock is called with the Lambda's IAM role, which may only call `bedrock-mantle:CreateInference`, update the usage table and read that one parameter.
- **Not a general Claude proxy.** The client sends only a prompt (≤ 24,000 characters) and 1–6 JPEG previews (each ≤ 2 MB decoded, must start with `FF D8`). The server picks the model (`AllowedModel`) and the schema (TonePilot's assessment schema for one image, the batch schema for several); any other field in the body is ignored. Every answer is constrained to that schema by structured outputs.
- **Caps.** Each license may assess `DailyPhotoCap` photos per UTC day (default 1,000). The count is reserved with one conditional DynamoDB update *before* the model is called, so concurrent requests cannot overshoot it. Photos of failed calls stay counted. The API stage is throttled to 10 requests/s (burst 20) across all licenses.
- **Zero retention by TonePilot.** Prompts, images and answers are never logged or stored. One log line per request: `licenseId`, image count, input/output tokens, ms, status. Errors returned to the app carry no internal detail (400 invalid, 401 license, 429 cap, 502 model). Bedrock's own data handling is AWS's; keep Bedrock **model invocation logging off** in this account, or prompts and images would be stored by it.
- **Cost alarm.** An AWS Budgets monthly cost budget e-mails `BudgetEmail` at 80% actual and 100% forecast. It alerts only; the caps and throttling are what limit spend.
- **On the app side** the license is sent only over HTTPS (plain HTTP only to localhost), and server answers map to clear messages: "TonePilot license expired", "Daily limit reached", "AI service unavailable".

Known limits: there is no revocation list (a license works until it expires, or until the secret is rotated, which ends all licenses once Lambda containers recycle), so keep licenses short (e.g. 31 days). A license is a bearer token: whoever holds it shares its cap. HTTP APIs end every request at 30 s, which suits one photo per call (the default); opt-in batches of several photos may not finish in time. Lambda's 6 MB request limit bounds a whole request (TonePilot's 1024-px previews are typically far smaller).

## Deploy (owner)

Nothing here has been deployed. Prerequisites: an AWS account, the AWS CLI, the [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), Node.js 22.

1. **Bedrock model access.** In the Bedrock console, request access to the model you will allow (default `anthropic.claude-opus-5-5`) in the region you deploy to.
2. **Create the license secret** (never commit it):
   ```sh
   aws ssm put-parameter --name /tonepilot/license-secret --type SecureString \
     --value "$(openssl rand -base64 48)"
   ```
3. **Build and deploy:**
   ```sh
   cd TonePilot/Cloud
   ./stage.sh && sam build && sam deploy --guided   # asks for BudgetEmail, AllowedModel, DailyPhotoCap…
   ```
   The `ApiUrl` output is the app's `TONEPILOT_CLOUD_URL`.
4. **Mint a license:**
   ```sh
   TONEPILOT_LICENSE_SECRET="$(aws ssm get-parameter --name /tonepilot/license-secret \
     --with-decryption --query Parameter.Value --output text)" \
     node mint-license.mjs customer-0001 31
   ```
5. **Use it.** The engine reads `TONEPILOT_AI_PROVIDER=cloud`, `TONEPILOT_CLOUD_URL` and `TONEPILOT_LICENSE` from its environment (the app passes its own environment through; there is no license field in the app yet).

To remove everything: `sam delete`, then delete the SSM parameter.

## What it costs (estimates, not measured)

No request has run against Bedrock through this backend, so these are list-price arithmetic, not bills. Check current [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) before deploying.

| Item | Rough estimate |
|---|---|
| Claude Opus 5.5 per photo | ~$0.02–0.05, assuming ~2–3k input tokens (one 1024-px preview + prompt) and ~0.5–2k output tokens incl. thinking at medium effort, at Anthropic's list price of $4 / $20 per million tokens; Bedrock sets its own prices, and regional endpoints carry a 10% premium |
| Worst case per license per day | `DailyPhotoCap` × per-photo cost: ~$20–50 at the default cap of 1,000 |
| Lambda (arm64, 512 MB, ~10 s/photo) | ~$0.07 per 1,000 photos |
| API Gateway HTTP API | ~$0.001 per 1,000 requests |
| DynamoDB on-demand (2 small writes/request) | well under $0.01 per 1,000 requests |
| CloudWatch Logs, SSM standard parameter, one budget | cents per month or free tier |

The model dominates: everything else is well under 1% of it.

## Unverified

- **IAM resource ARNs.** `bedrock-mantle:CreateInference` is the action named by Anthropic's [Claude in Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock) page and AWS's Projects IAM examples, which scope it to a project ARN (`…:project/default` is used here). The **model** ARN form in the template (`arn:aws:bedrock-mantle:<region>::model/<model id>`) is a guess: check the Service Authorization Reference for Amazon Bedrock Mantle and adjust before relying on model scoping. A wrong ARN can only deny access; the model is also fixed by `ALLOWED_MODEL` in code.
- **SAM.** The template has not been through `sam validate` (SAM CLI not installed here) or a deployment; `BuildProperties: UseNpmCi` and the `.build` layout are untested with `sam build`. The staged package was checked locally: it installs from the lockfile (~90 MB unpacked, under Lambda's 250 MB) and `Cloud/lambda.mjs` imports and answers a request without AWS.
- **Latency, real token counts, Bedrock behaviour with this schema, and costs** have not been measured.
