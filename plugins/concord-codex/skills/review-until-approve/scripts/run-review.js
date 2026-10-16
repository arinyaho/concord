#!/usr/bin/env node
'use strict';
// Runs one review-only round in the current directory (the untrusted checkout) and
// prints the runner's result as one JSON line. Options come as JSON in argv[2].
const path = require('node:path');

const { core, cli: hook } = require('./locate');
const options = JSON.parse(process.argv[2]);
require(path.join(core, 'codex-review-runner')).runReviewUntilGreen({
  ...options, reviewOnly: true, handleSignals: true, repoRoot: process.cwd(), cliPath: hook, publicCliPath: hook,
}).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => { process.stderr.write(`review-until-approve: ${error.message}\n`); process.exit(1); });
