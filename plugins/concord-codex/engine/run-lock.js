'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Stale-lock recovery for mkdir-style lock directories that hold an `owner` pid file.
const STALE_OWNERLESS_MS = 60 * 1000;

function lockOwner(lock) {
  try { const pid = Number.parseInt(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), 10); return Number.isInteger(pid) && pid > 0 ? pid : null; } catch (_) { return null; }
}

function pidRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// A lock is stale when its owner pid is not running on this machine, or when it
// never recorded an owner and is old. ponytail: pid liveness is local only; a lock
// owned by another host sharing the state directory looks dead and is reclaimed.
function lockIsStale(lock) {
  const pid = lockOwner(lock);
  if (pid) return !pidRunning(pid);
  try { return Date.now() - fs.statSync(lock).mtimeMs > STALE_OWNERLESS_MS; } catch (_) { return false; }
}

// Removes a stale lock by renaming it first, so one contender wins, then deleting it.
function reclaimStaleLock(lock) {
  if (!lockIsStale(lock)) return false;
  const aside = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(lock, aside); } catch (_) { return false; }
  fs.rmSync(aside, { recursive: true, force: true });
  return true;
}

module.exports = { lockOwner, pidRunning, lockIsStale, reclaimStaleLock };
