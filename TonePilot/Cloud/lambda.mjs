// Production wiring for handler.mjs (the Lambda entry point): the license secret from SSM
// Parameter Store, the usage counter in DynamoDB, and Claude on Amazon Bedrock through the
// Engine's own provider, signed with the function's IAM role. Every setting comes from
// template.yaml; nothing in a request can change the model, endpoint or cap.
import {DynamoDBClient, UpdateItemCommand} from '@aws-sdk/client-dynamodb';
import {SSMClient, GetParameterCommand} from '@aws-sdk/client-ssm';
import {claudeProvider} from '../Engine/claude.mjs';
import {createHandler} from './handler.mjs';

const {USAGE_TABLE, ALLOWED_MODEL, DAILY_PHOTO_CAP, LICENSE_SECRET_PARAMETER, AWS_REGION} = process.env;
const RETAIN_DAYS = 90;   // usage rows then expire through the table's TTL
const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

let secret;   // cached for the life of the container; a rotated secret applies to new containers
const getSecret = () => (secret ??= ssm.send(new GetParameterCommand({Name: LICENSE_SECRET_PARAMETER, WithDecryption: true}))
  .then(r => r.Parameter.Value)
  .catch(e => { secret = undefined; throw e; }));

const update = (licenseId, day, params) => dynamo.send(new UpdateItemCommand({
  TableName: USAGE_TABLE, Key: {pk: {S: licenseId + '#' + day}}, ...params}));

const usage = {
  // One conditional write: the count only grows while it stays within the cap.
  async reserve({licenseId, day, photos, cap}) {
    if (photos > cap) return false;
    try {
      await update(licenseId, day, {
        UpdateExpression: 'ADD photos :n SET expiresAt = if_not_exists(expiresAt, :ttl)',
        ConditionExpression: 'attribute_not_exists(photos) OR photos <= :max',
        ExpressionAttributeValues: {':n': {N: String(photos)}, ':max': {N: String(cap - photos)},
          ':ttl': {N: String(Math.floor(Date.now() / 1000) + RETAIN_DAYS * 86400)}}});
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  },
  record: ({licenseId, day, inputTokens, outputTokens}) => update(licenseId, day, {
    UpdateExpression: 'ADD calls :one, inputTokens :i, outputTokens :o',
    ExpressionAttributeValues: {':one': {N: '1'}, ':i': {N: String(inputTokens)}, ':o': {N: String(outputTokens)}}})
};

// An explicit environment: only the model and region reach the provider.
const model = claudeProvider('bedrock', {TONEPILOT_AI_MODEL: ALLOWED_MODEL, AWS_REGION});

export const handler = createHandler({getSecret, usage, model, dailyCap: Number(DAILY_PHOTO_CAP)});
