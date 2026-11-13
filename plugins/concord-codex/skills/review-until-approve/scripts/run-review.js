#!/usr/bin/env node
'use strict';
// Runs one review round in the current directory (the untrusted checkout) and
// prints the result as one JSON line. Options come as JSON in argv[2].
const options = JSON.parse(process.argv[2]);
// Under Claude Code the reviewer roles are answered by the driving session's subagents instead of a `claude -p` process.
const subagent = options.broker ? { spawn: require('./broker').requester(options.broker, { timeoutMs: options.brokerTimeoutMs, parentPid: process.ppid }) } : {};
require('./runner/review').runReview({ ...options, ...subagent, handleSignals: true, repoRoot: process.cwd() })
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => { process.stderr.write(`review-until-approve: ${error.message}\n`); process.exitCode = 1; });
