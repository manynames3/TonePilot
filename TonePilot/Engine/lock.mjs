// One mutating engine at a time. If the Mac app is force-quit, its engine child
// keeps running (macOS does not kill orphans); a relaunched app must not start a
// second writer beside it. Read-only modes never take this lock.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const LOCK = '.engine.lock';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Guard against PID reuse after a reboot: the holder must still be a TonePilot engine.
function isEngine(pid) {
  const ps = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {encoding: 'utf8'});
  return ps.status === 0 && /engine\.mjs/.test(ps.stdout);
}

export function readLock(runs) {
  try {
    const holder = JSON.parse(fs.readFileSync(path.join(runs, LOCK), 'utf8'));
    if (Number.isInteger(holder.pid) && alive(holder.pid) && isEngine(holder.pid)) return holder;
  } catch { /* missing or unreadable lock means nobody holds it */ }
  return null;
}

// Records which session the running engine is working on once that is known.
export function updateLock(runs, info) {
  const file = path.join(runs, LOCK);
  try {
    const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (holder.pid !== process.pid) return;
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({...holder, ...info}), {mode: 0o600});
    fs.renameSync(tmp, file);
  } catch { /* informational only */ }
}

export function acquireLock(runs, info) {
  fs.mkdirSync(runs, {recursive: true, mode: 0o700});
  const file = path.join(runs, LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString(), ...info}));
      fs.closeSync(fd);
      const release = () => {
        try {
          const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (holder.pid === process.pid) fs.unlinkSync(file);
        } catch { /* already gone */ }
      };
      process.on('exit', release);
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readLock(runs);
      if (holder) {
        throw new Error('Another TonePilot operation is still running (' + (holder.mode || 'engine') +
          (holder.session ? ', ' + holder.session : '') + '). Wait for it to finish or stop it first.');
      }
      try { fs.unlinkSync(file); } catch { /* raced with another cleanup */ }
    }
  }
  throw new Error('Could not acquire the TonePilot engine lock');
}
