'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

function captureArtifactRoot(directory) {
  const absolute = path.resolve(directory);
  const real = fs.realpathSync(absolute);
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) throw new Error('harness-failure: review artifact directory is invalid');
  return { absolute, real, dev: stat.dev, ino: stat.ino };
}

function withArtifact(file, root, allowMissing, consume) {
  const absolute = path.resolve(file);
  const unsafe = () => new Error(`harness-failure: unsafe or oversized review artifact: ${path.basename(file)}`);
  if (path.dirname(absolute) !== root.absolute) throw unsafe();
  const checkRoot = () => {
    try {
      const stat = fs.statSync(root.absolute);
      if (!stat.isDirectory() || stat.dev !== root.dev || stat.ino !== root.ino || fs.realpathSync(root.absolute) !== root.real) throw unsafe();
    } catch (_) { throw unsafe(); }
  };
  const checkPath = (before) => {
    checkRoot();
    try {
      const current = fs.lstatSync(absolute);
      if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino
        || fs.realpathSync(absolute) !== path.join(root.real, path.basename(absolute))) throw unsafe();
    }
    catch (_) { throw unsafe(); }
  };
  checkRoot();
  let before;
  try { before = fs.lstatSync(absolute); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') { checkRoot(); return null; }
    throw unsafe();
  }
  if (!before.isFile() || before.size > MAX_BYTES) throw unsafe();
  let fd;
  try {
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    const sameFile = (stat) => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino
      && stat.size === before.size && stat.size <= MAX_BYTES;
    if (!sameFile(fs.fstatSync(fd))) throw unsafe();
    checkPath(before);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, MAX_BYTES + 1 - bytes), null);
      if (!count) break;
      bytes += count;
      if (bytes > MAX_BYTES) throw unsafe();
      consume(buffer.subarray(0, count));
    }
    if (bytes !== before.size || !sameFile(fs.fstatSync(fd))) throw unsafe();
    checkPath(before);
    return true;
  } catch (_) { throw unsafe(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function hashArtifact(file, root, { allowMissing = false } = {}) {
  const digest = crypto.createHash('sha256');
  return withArtifact(file, root, allowMissing, (chunk) => digest.update(chunk)) === null ? null : digest.digest('hex');
}

function readArtifactBytes(file, root, { allowMissing = false } = {}) {
  const chunks = [];
  return withArtifact(file, root, allowMissing, (chunk) => chunks.push(Buffer.from(chunk))) === null ? null : Buffer.concat(chunks);
}

module.exports = { MAX_BYTES, captureArtifactRoot, hashArtifact, readArtifactBytes };
