'use strict';
const fs = require('node:fs');
const path = require('node:path');

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

// Removes a stale lock. Contenders serialise on a `<lock>.reclaim` guard directory, and the
// staleness check runs while holding it, so a lock another contender took after the check
// can never be removed: a lock is only ever created when absent, and only the guard holder
// removes one. ponytail: a reclaimer that dies holding the guard leaves it until it is older
// than STALE_OWNERLESS_MS; that expiry is the one remaining unserialised removal.
function reclaimStaleLock(lock) {
  const guard = `${lock}.reclaim`;
  try { fs.mkdirSync(guard); } catch (error) {
    if (error.code === 'EEXIST') { try { if (Date.now() - fs.statSync(guard).mtimeMs > STALE_OWNERLESS_MS) fs.rmSync(guard, { recursive: true, force: true }); } catch (_) {} }
    return false;
  }
  try {
    if (!lockIsStale(lock)) return false;
    fs.rmSync(lock, { recursive: true, force: true });
    return true;
  } finally { fs.rmSync(guard, { recursive: true, force: true }); }
}

module.exports = { lockOwner, pidRunning, lockIsStale, reclaimStaleLock };
