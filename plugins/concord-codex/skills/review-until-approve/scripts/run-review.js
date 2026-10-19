#!/usr/bin/env node
'use strict';
// Runs one review-only round in the current directory (the untrusted checkout) and
// prints the runner's result as one JSON line. Options come as JSON in argv[2].
const path = require('node:path');

const { core, cli: hook } = require('./locate');
const options = JSON.parse(process.argv[2]);
// Reviewers must be able to call Concord without opening the account's plugin
// cache (and its changing SQLite sidecars) through the home deny list.
const { snapshotRunEngine } = require(path.join(core, 'run-snapshot'));
const snapshot = snapshotRunEngine(path.dirname(core), process.cwd());
process.once('exit', snapshot.remove);
require(path.join(snapshot.root, 'engine', 'codex-review-runner')).runReviewUntilGreen({
  ...options, reviewOnly: true, repairFindingAnchors: true, handleSignals: true, repoRoot: process.cwd(), cliPath: snapshot.cliPath, publicCliPath: hook, reviewRuntimeDir: snapshot.root,
}).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => { process.stderr.write(`review-until-approve: ${error.message}\n`); process.exitCode = 1; })
  .finally(snapshot.remove);
