#!/usr/bin/env node
'use strict';
// Token-free wait for review-until-approve. Reads the ledger (never writes it), polls
// GitHub through `gh`, prints exactly one JSON event line, then exits. Run it under
// the host's background watch (Monitor) and under `mien exec <profile> --` where the
// reviewing account is not the ambient one.
// usage: watch.js <ledger.json> <owner/repo> <pr> [--interval <seconds>]
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const lib = require('./lib');

const MAX_FAILURES = 10;
const [ledgerPath, repo, pr, ...rest] = process.argv.slice(2);
if (!ledgerPath || !repo || !pr) { process.stderr.write('usage: watch.js <ledger.json> <owner/repo> <pr> [--interval <seconds>]\n'); process.exit(2); }
const intervalFlag = rest.indexOf('--interval');
const intervalMs = (intervalFlag === -1 ? 60 : Number(rest[intervalFlag + 1])) * 1000;

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args[0]} failed: ${(r.stderr || '').slice(0, 200)}`);
  return JSON.parse(r.stdout || 'null');
}
// --paginate prints one JSON array per page; --slurp joins them.
const pages = (path) => gh(['api', '--paginate', '--slurp', path]).flat();

const emit = (event, code = 0) => { process.stdout.write(`${JSON.stringify(event)}\n`, () => process.exit(code)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let previousHead = null;
  let failures = 0;
  for (;;) {
    try {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const view = gh(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid,state,isDraft,author']);
      const live = { head: view.headRefOid, state: view.state, isDraft: view.isDraft, author: view.author.login };
      const replies = lib.repliesSince(ledger, pages(`repos/${repo}/pulls/${pr}/comments`), pages(`repos/${repo}/issues/${pr}/comments`), live.author);
      const event = lib.wakeDecision({ ledger, live, replies, now: Date.now(), stable: previousHead === live.head });
      previousHead = live.head;
      failures = 0;
      if (event) return emit(event);
    } catch (error) {
      if (++failures >= MAX_FAILURES) return emit({ event: 'error', detail: String(error.message) }, 1);
    }
    await sleep(intervalMs * Math.min(2 ** failures, 8));
  }
})();
