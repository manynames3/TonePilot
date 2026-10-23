// Client for TonePilot's own Lightroom Classic plug-in (TonePilot/LightroomPlugin).
// Same interface as LightroomMCP. LrSocket sockets are one-way, so requests go to one
// localhost port and responses come back on another, as newline-delimited JSON; every
// request carries the token the plug-in wrote to bridge.json.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {BridgeError} from './lightroom.mjs';

export const bridgeFile = () => process.env.TONEPILOT_BRIDGE_FILE ||
  path.join(os.homedir(), 'Library/Application Support/TonePilot/bridge.json');

function readBridgeFile(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const port = n => Number.isInteger(n) && n > 0 && n < 65536;
  if (!port(cfg.requestPort) || !port(cfg.responsePort) || typeof cfg.token !== 'string' || cfg.token.length < 32)
    throw new Error('Invalid TonePilot bridge file');
  return cfg;
}

function openSocket(port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host: '127.0.0.1', port});
    const timer = setTimeout(() => { socket.destroy(); reject(new BridgeError('Lightroom plug-in did not accept a connection', 'timeout')); }, timeout);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', e => { clearTimeout(timer); reject(new BridgeError('Lightroom plug-in unavailable: ' + e.message, 'closed')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class TonePilotBridge {
  constructor({file = bridgeFile(), timeout = 30000, writeTimeout = Number(process.env.TONEPILOT_WRITE_TIMEOUT_MS) || 40000,
    connectTimeout = 8000} = {}) {
    Object.assign(this, {file, timeout, writeTimeout, connectTimeout});
    this.kind = 'tonepilot'; this.sequence = 0;
    // Request ids are unique to this client: a reply the plug-in still owes an engine that
    // died can never match a request of the next one.
    this.nonce = randomBytes(8).toString('hex'); this.pending = new Map(); this.buffer = '';
    this.requests = null; this.responses = null; this.ready = false; this.closed = false;
    this.serverInfo = null; this.writableKeys = null;
  }

  async connect() {
    const cfg = readBridgeFile(this.file);
    this.token = cfg.token;
    this.requests = await openSocket(cfg.requestPort, 2000);
    this.requests.on('error', () => {});
    this.requests.on('close', () => this.lost());
    // The plug-in starts a fresh response listener when an engine connects, so the first
    // response connection can be dropped; reconnect until hello is answered.
    const deadline = Date.now() + this.connectTimeout;
    let hello;
    for (;;) {
      try {
        this.attach(await openSocket(cfg.responsePort, 2000));
        hello = await this.request('hello', {client: 'TonePilot Engine', version: process.env.TONEPILOT_VERSION || 'dev', pid: process.pid}, 1500);
        break;
      } catch (e) {
        if (e.kind === 'tool' || this.closed || Date.now() > deadline) throw e;
        await sleep(200);
      }
    }
    this.ready = true;
    this.serverInfo = {name: 'TonePilot plug-in', version: hello.pluginVersion || null,
      lightroom: hello.lightroomVersion || null, catalog: hello.catalogPath || null};
    this.writableKeys = new Set((await this.tool('writable_keys')).keys || []);
    return this;
  }

  attach(socket) {
    this.responses?.destroy();
    this.responses = socket;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => this.onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => { if (this.responses === socket) { if (this.ready) this.lost(); else this.failAll(new BridgeError('Lightroom plug-in reconnecting', 'closed')); } });
  }

  lost() {
    this.closed = true;
    this.failAll(new BridgeError('Lightroom plug-in closed the connection', 'closed'));
  }

  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(msg.id);
      if (msg.error !== undefined && msg.error !== null) pending.reject(new BridgeError(String(msg.error), 'tool'));
      else pending.resolve(msg.result ?? {});
    }
  }

  request(action, params = {}, timeout = this.timeout) {
    const id = this.nonce + ':' + ++this.sequence;
    return new Promise((resolve, reject) => {
      if (this.closed || !this.requests || this.requests.destroyed) return reject(new BridgeError('Lightroom plug-in unavailable', 'closed'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('Lightroom ' + action + ' timed out after ' + timeout + 'ms', 'timeout'));
      }, timeout);
      this.pending.set(id, {resolve, reject, timer});
      this.requests.write(JSON.stringify({id, token: this.token, action, params}) + '\n');
    });
  }

  async tool(name, args = {}) {
    const timeout = name === 'get_photo_preview' ? 45000 : name === 'set_develop_settings' ? this.writeTimeout : this.timeout;
    const result = await this.request(name, args, timeout);
    if (args.photo_id !== undefined && result?.photo_id !== undefined && String(result.photo_id) !== String(args.photo_id))
      throw new BridgeError('Lightroom answered for another photo', 'timeout');   // outcome unknown: settle from read-back
    return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  }

  async close() {
    this.closed = true;
    this.failAll(new BridgeError('Bridge closed', 'closed'));
    this.requests?.destroy(); this.responses?.destroy();
    this.requests = this.responses = null;
  }

  failAll(error) {
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
  }
}
