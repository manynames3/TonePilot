#!/usr/bin/env node
// TonePilot read-only Lightroom selection scanner.
// Makes exactly one Lightroom MCP tool call: get_selected_photos.
import { spawn } from 'node:child_process';

const home = process.env.HOME || '';
const npxPath = home + '/.local/bin/npx';
const bin = process.env.TONEPILOT_NPX ?? npxPath;
const child = spawn(bin, ['-y', '@mskalski/lightroom-mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PATH: home + '/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
});
let completed = false;
let responseText = '';
const timer = setTimeout(() => stopWithError('The Lightroom bridge did not respond within 25 seconds.'), 25000);

function shutdown() {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill('SIGTERM');
}
function stopWithError(reason) {
  if (completed) return;
  completed = true;
  process.stdout.write(JSON.stringify({ error: reason, count: 0, photos: [] }) + '\n');
  shutdown();
  process.exitCode = 1;
}
function send(message) {
  if (!completed && child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n');
}
function normalize(result) {
  if (result?.isError) throw new Error(result.content?.[0]?.text || 'Lightroom returned an error.');
  const raw = result?.structuredContent?.result ?? result?.structuredContent;
  if (raw && typeof raw === 'object' && typeof raw.count === 'number') return raw;
  for (const part of result?.content ?? []) {
    if (part.type !== 'text') continue;
    try {
      const obj = JSON.parse(part.text);
      if (obj && typeof obj.count === 'number') return obj;
      if (obj.result && typeof obj.result.count === 'number') return obj.result;
    } catch {}
  }
  throw new Error('The Lightroom bridge returned an unexpected response format.');
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  responseText += chunk;
  let newline;
  while ((newline = responseText.indexOf('\n')) !== -1) {
    const line = responseText.slice(0, newline).trim();
    responseText = responseText.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) {
      if (message.error) { stopWithError(message.error.message || 'MCP initialization failed.'); return; }
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_selected_photos', arguments: { limit: 26, offset: 0 } } });
    } else if (message.id === 2) {
      try {
        if (message.error) throw new Error(message.error.message || 'Selection lookup failed.');
        const result = normalize(message.result);
        const photos = (result.photos ?? []).map(x => ({
          id: String(x.id ?? ''),
          filename: String(x.filename ?? x.fileName ?? '')
        })).filter(x => x.id.length > 0);
        if (completed) return;
        completed = true;
        process.stdout.write(JSON.stringify({ count: result.count, photos }) + '\n');
        shutdown();
      } catch (error) { stopWithError(error.message); }
      return;
    }
  }
});
child.on('error', error => stopWithError('Unable to launch Lightroom bridge: ' + error.message));
child.on('exit', code => {
  if (!completed) stopWithError('Lightroom connection closed early (exit ' + String(code) + ').');
});
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'TonePilot', version: '0.2.0' } }
});
