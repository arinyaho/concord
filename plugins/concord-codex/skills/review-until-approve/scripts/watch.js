#!/usr/bin/env node
'use strict';
// Wait for review-until-approve that makes no model call while it polls. Reads the ledger (never writes it), polls
// GitHub through `gh`, prints exactly one JSON event line, then exits. Run it as
// a background command (Bash run_in_background) and under `mien exec <profile> --` where the
// reviewing account is not the ambient one. With --max-wait it prints {"event":"idle"}
// after that many seconds without an event, so a host without a background watch can
// run it in the foreground and call it again. `<ledger>.watch.json` carries the head
// seen, the nudge shown and the failed polls in a row from one run to the next; the ledger itself is never written.
// usage: watch.js <ledger.json> <owner/repo> <pr> [--interval <seconds>] [--max-wait <seconds>]
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const lib = require('./lib');

const MAX_FAILURES = 10;
const [ledgerPath, repo, pr, ...rest] = process.argv.slice(2);
const usage = () => { process.stderr.write('usage: watch.js <ledger.json> <owner/repo> <pr> [--interval <seconds>] [--max-wait <seconds>]\n'); process.exit(2); };
if (!ledgerPath || !repo || !pr) usage();
// A flag's value must be a positive number of seconds; anything else would make a timer fire at once.
function seconds(flag, fallback) {
  const at = rest.indexOf(flag);
  if (at === -1) return fallback;
  const value = Number(rest[at + 1]);
  return value > 0 && Number.isFinite(value) ? value : usage();
}
const intervalMs = seconds('--interval', 60) * 1000;
const deadline = Date.now() + seconds('--max-wait', Infinity) * 1000;
const sidecarPath = `${ledgerPath}.watch.json`;
const readSidecar = () => { try { return JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch (_) { return {}; } };
const writeSidecar = (data) => { try { fs.writeFileSync(sidecarPath, JSON.stringify(data)); } catch (_) { /* the next run only repeats a notice */ } };

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh ${args[0]} failed: ${(r.stderr || '').slice(0, 200)}`);
  return JSON.parse(r.stdout || 'null');
}
// --paginate prints one JSON array per page; --slurp joins them.
const pages = (path) => gh(['api', '--paginate', '--slurp', path]).flat();

const emit = (event, code = 0) => { process.stdout.write(`${JSON.stringify(event)}\n`, () => process.exit(code)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sameNudge = (a, b) => a && b && a.kind === b.kind && a.head === b.head && a.replyAt === b.replyAt;

(async () => {
  const sidecar = readSidecar();
  let previousHead = sidecar.previousHead ?? null;
  let previousIntent = sidecar.previousIntent ?? null;
  let failures = sidecar.failures ?? 0;
  for (;;) {
    try {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const view = gh(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid,state,isDraft,author,title,body']);
      const live = { head: view.headRefOid, state: view.state, isDraft: view.isDraft, author: view.author.login, intent: lib.intentOf(view.title, view.body) };
      const replies = lib.repliesSince(ledger, pages(`repos/${repo}/pulls/${pr}/comments`), pages(`repos/${repo}/issues/${pr}/comments`), live.author);
      let event = lib.wakeDecision({ ledger, live, replies, now: Date.now(), stable: previousHead === live.head && previousIntent === live.intent });
      if (event && event.event === 'nudge' && sameNudge(event, sidecar.nudged)) event = null;
      previousHead = live.head;
      previousIntent = live.intent;
      failures = 0;
      if (event && event.event === 'nudge') sidecar.nudged = { kind: event.kind, head: event.head, replyAt: event.replyAt };
      writeSidecar({ ...sidecar, previousHead, previousIntent, failures });
      if (event) return emit(event);
    } catch (error) {
      writeSidecar({ ...sidecar, previousHead, previousIntent, failures: ++failures % MAX_FAILURES });
      if (failures >= MAX_FAILURES) return emit({ event: 'error', detail: String(error.message) }, 1);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return emit({ event: 'idle' });
    await sleep(Math.min(intervalMs * Math.min(2 ** failures, 8), remaining));
    if (Date.now() >= deadline) return emit({ event: 'idle' });
  }
})();
