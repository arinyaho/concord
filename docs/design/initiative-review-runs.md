# Initiative review runs

An initiative review run bounds the review work of one initiative with one durable budget. An opt-in run supplies an opaque run key, a canonical initiative state directory, and immutable launch and round budgets. Every review launch under that key, across every target and every distribution (the Codex runner and the native Claude and Copilot drivers), is reserved against the same run ledger. With no run key, target-local accounting, `reset`, and `rerun` behave as they do for any standalone review.

The delivery mode (`base` or `lite`), escalation, and the `initiative-to-prs` workflow are described in the initiative delivery modes design. The completion report rendered at finalise is described in the initiative completion report design.

## Run ledger

The run ledger is `initiative-review-<sha256(key)>.json` in the initiative state directory. It is schema version 5; a ledger of any older version is rejected, never upgraded, so a replay never infers terminal state, a resolved base, or a mode from fields the ledger does not state.

The ledger contains no key, prompt, source text, artifact path, environment, or credential. It may retain raw target refs and base/head revisions for local audit and reconciliation handoff only. Project aggregates and external tracker or PR output use SHA-256 target IDs and aggregate counts only.

The execution root and the state directory are canonicalized through their nearest existing ancestor before the runner derives paths, evaluates Git ignore rules, or opens a ledger. Git-ignore validation applies only when that canonical root is a Git worktree, and it checks the actual hashed ledger path.

The per-ref target ledger stays the source of review findings. With a run key, the launch and round budgets are immutable: `reset` or `rerun` of a target ledger cannot alter them. The CLI flags `--initiative-run-key`, `--initiative-state-dir`, `--initiative-max-launches`, and `--initiative-max-rounds` must be supplied together and are validated and opened by the same code for every distribution; reopening a run compares the supplied budgets with the stored ones.

## Launch reservation

Each reviewer, fixer, panel lens, and panel vote reserves one launch through an exclusive filesystem lock before it is spawned. A failed or crashed process has already consumed its reservation, and a reservation whose launch never happens still consumes budget. Lock contention and exhausted budgets deny the launch, so separate worktrees cannot race for a final slot.

### Codex runner

The Codex runner spawns its reviewers from code, so it reserves each launch itself immediately before spawning it. The reservation is a physical gate.

### Native drivers: enforcement at evidence acceptance

Native reviewers, fixers, panel lenses, and votes are spawned by the host model following the driver prose, not by code. The CLI sees only the artifacts they leave behind, so it cannot prevent a launch. The guarantee is instead that an unreserved launch cannot produce accepted evidence.

- The driver calls `reserve <ref> <role> [--count N]` before each launch or fan-out and launches only after `granted`. Roles are `correctness`, `verify`, `plan`, `intent`, `gate-review`, `gate-verify`, `fix`, `certify`, `lens` (the five panel lenses as one batch), and `vote` (a multiple of three).
- A batch is reserved under one run-ledger lock in one write: it is granted or denied as a unit, and a denial consumes nothing. `reserve` reports the cause as `reason` (`budget-exhausted`, `target-terminal`, or `inactive` when the run is finalised, its ledger is missing, or the round or count is invalid; absent for contention), and answers `reconciliation-required` as its status when the run is parked and the launch would open a new revision pair.
- A granted reservation stores a random token in the target ledger only and prints it to the driver. The token is an opaque receipt: matching uses role, round, panel round, and count, and never compares the token. The run ledger records role, round, and target, never an artifact path or token.
- The target ledger keeps a per-role counter (keyed by role, round, and panel round) of superseded launches, attempts whose artifact was overwritten by a later launch. An artifact repair (see the review artifact contract design) adds one for its role, and `round-failure` adds one when it names a gate artifact role (`correctness`, `verify`, `plan`, `intent`, `gate`, or `gate-verify`). Evidence is accepted only when the reserved count covers the accepted launch plus every counted superseded launch, so a retry needs a fresh `reserve`. An incomplete semantic plan rejection also supersedes its plan launch once, before a fresh planner reservation. The counter lives in the target ledger only.
- `artifact-normalize` for a plan, `plan-fixes`, `record`, `commit-fix`, and `gate-panel-round-record` reject any artifact whose role has no matching reservation for the active round and panel round, fail the run closed by finalising it, and exit with a `harness-failure`. `commit-fix` consumes one unit of `fix` reservation per journaled commit, counted only when the journal entry is written.
- A material intent, design-conformance, or AC-coverage finding yields an empty fixer plan and `reconciliation-required`; the driver reserves `fix` only for a non-empty plan.

## Locks

### Target-ledger lock

Under a keyed run, every verb that reads and writes the target ledger (except the read-only `show`) runs inside one target-ledger lock, an exclusive `mkdir` with bounded retry, and the ledger is written through a temporary file and a rename. `reserve` takes its run-ledger batch reservation inside that critical section, so parallel `reserve` calls on one target serialize instead of denying each other.

The holder writes its pid into the lock directory. If the lock cannot be taken within the bound, the verb fails with the lock path, the recorded owner pid and whether it is still running (or `owner unknown`), and the `rm -r` command that clears a lock left by a killed process. On an interactive terminal the verb first asks whether to remove the lock (default no) and removes it only after an explicit yes; without a terminal it never asks. The pid is displayed only and no code path decides from it, so the target-ledger lock is never reclaimed automatically. The lock is held across the whole verb, including the Definition of Done in `round-start`, so a killed verb can leave it behind.

### Run-ledger lock

The run-ledger lock is one non-retrying exclusive `mkdir` held for a single read-modify-write, so its window is milliseconds and contention with other targets or with the Codex runner yields `denied`, which is fail-closed. A contended denial names the lock and its owner.

The holder records its pid. A contender that finds the lock held by a dead pid removes it and retries once. Contenders first serialize on a `<lock>.reclaim` guard directory created with an exclusive `mkdir`; the guard holder re-checks staleness and then removes the lock, so a lock another contender created after an earlier check is never removed. A holder releases the lock only while its own pid is still recorded as the owner. An ownerless lock is treated as stale only when older than a fixed age, because a holder that has just created the directory has not yet written its pid. A lock whose owner pid is running on this machine is never taken.

## Revision-pair targets

Under one run key, a target is identified by its revision pair: the ref, the base, and the head (`head_sha`, which is a content identity for a file target). For a repository ref the stored base is the commit the base name resolves to when the pair is built, never the name, so a base that moves under the same name is a different pair even when the head is unchanged. A base that does not resolve is stored as given. The per-ref target ledger keeps the base name.

- A terminal disposition refuses every later launch and every later terminal record for its own revision pair, and only for that pair. Another head or base of the same ref is a new target under the same key, charged to the same shared budget, so a fix pass or base drift can be re-verified without opening a new key.
- Native `reserve` and `record` use one pair per round: the head stored at `round-start`, which the reviewers examined. `record` writes the terminal disposition on that head, not on the live head, so a commit that lands mid-round cannot move the terminal onto a head that was never reserved. The changed head is reviewed as its own pair after `rerun <ref>`.
- Each pair adds its own entry to the run's target list, so aggregate output carries one hashed identifier per pair and counts only.
- The per-ref target ledger stays terminal until `rerun <ref>`, which re-arms it and archives the finished run. A re-verification is `rerun <ref>` followed by a normal keyed review of the new head.
- A keyed rerun checks for an existing terminal target before `round-start` and returns the stored safe aggregate only when the target and its full pair match. On resume, the base comes from the per-ref ledger (`target.base`), never from a stored disposition, which would compare a pair with itself. A repository ref whose ledger records no base fails closed before identity work when the run holds a terminal or escape disposition for it, and otherwise proceeds. A stored disposition with no head, or no base for a git ref, matches no revision: it neither replays nor blocks a new pair.

## Disposition journal

Every terminal runner result is normalized into one durable disposition: `terminal`, `error`, or `escape`. A terminal disposition is the only replay and identity authority; error and escape entries are retained for audit but do not suppress a later retry. Duplicate dispositions are ignored under the ledger lock.

Retaining an error disposition does not authorize retry by itself. Its continuation packet reflects the target ledger's bounded recovery state: actionable work uses `resume`, while exhausted or terminal planner execution failure uses `terminal-handoff`. Canonical provider diagnostics preserve classification without raw credentials. See [failed planner provider recovery](planner-provider-recovery.md).

- `escape` covers `record`'s re-runnable stop states, `gate-pending` and `intent-review`, where a human dismisses or resolves the reported finding and a fresh `round-start` clears it, plus a literal `escape` decision. A material finding (every parked intent finding, or a design-conformance or AC-coverage gate finding) always carries a reconciliation, which takes precedence and stays `terminal`, so these states land as `escape` only when the open finding is non-material.
- `error` is a harness or runner failure (a thrown exception).
- Every other outcome (converged, parked, abandoned, or a reconciliation-required target) is `terminal`.

A keyed native `record` that reaches a terminal or escape outcome writes the disposition and then checks that it is present with matching target, revision, and kind, and reason for an escape (the journal's dedupe key). If the write was contended, or only an earlier escape with a different reason is present (for example an unconsumed `intent-review` escape written by the Codex runner, which shares the journal), `record` fails with a `harness-failure` and leaves the target ledger not `done`. Re-running `record` is safe because an identical unconsumed escape is deduplicated.

Terminal outcomes follow the same privacy contract on every path: raw refs and SHAs stay in the local ledger, and public summaries carry hashed target IDs and aggregate counts.

## Reconciliation and refusals

Before fixer planning, intent findings and design-conformance or AC-coverage gate findings become reconciliation work, for keyed and unkeyed runs alike. This deliberately suppresses correctness and docreview fixers in the same round.

While the run holds a `reconciliation-required` hint, a launch on a revision pair the run has not yet opened is refused as `reconciliation-required` and consumes nothing. Pairs already opened keep working, so a target mid-review is not cut off by another target's park. The Codex runner checks this before `round-start`, so a refused pair never runs the DoD or moves the per-ref ledger into gates. The hint is never cleared inside a run: resolving it is a human decision, and a materially approved contract revision starts a new run key.

A refusal has one of five causes, checked in this order: `inactive`, `reconciliation-required`, `target-terminal`, `budget-exhausted` (launch or round budget), or lock contention. The Codex runner returns `{ decision: 'reconciliation-required' }` or `{ decision: 'blocked', reason: 'budget-exhausted' }` without recording an error disposition, and its launcher prints the result and exits non-zero; contention and a terminal pair stay errors, because they signal a defect or a race, not a decision. A blocked outcome is not recorded in the run ledger, so a repeated attempt is refused again with the same outcome instead of adding records.

## Finalise and recovery

`finalise` (native) or `--initiative-finalise` (Codex) ends the run; later reservations are denied as `inactive`. Finalising an already-terminal ledger with matching options returns the same aggregate, re-renders the run's completion report, and rebuilds the project-level run index, so it is the recovery call after a crash between the terminal write and rendering. Repository, budget, and lock mismatches remain errors.

## Carrying a budget-blocked target

A shared budget can run out in the middle of a round, for example after the correctness launch lands but before verify's reservation is granted. The target stays bound to the exhausted key with reservations partly consumed and nowhere to go within that key. `carry` is the explicit, human-authorized step that moves such a target onto a new run key without losing the round's completed artifacts, after reconciliation has decided the new key's identity and budgets.

### Recovery marker

On a `budget-exhausted` denial against a target that is already bound, `reserve` persists `initiative_blocked: { key, stateDir, round, attemptId, role, count, revision }` on the target ledger, naming the exhausted key and the exact batch that was refused. An unbound target's first reservation writes nothing on denial: there is no binding to recover, and the target is free to retry under a corrected key or budget. The marker is advisory, not a lock; a stale marker (wrong round or attempt) refuses `carry` rather than corrupting anything.

### The verb

`review-cli carry <ref> --from-run-key <old-key>`, with the new key's full initiative options (and `--initiative-mode` if the run is lite), runs under the target lock. The round, attempt, role, count, and revision it acts on all come from the marker, not from the caller. Checks run in this order:

1. The target is bound to the old key under the given state directory (an unbound target is refused: there is no proven identity to carry from), is in an active review phase (`gates`, `fixes`, or a pending gate panel), is not parked for reconciliation, has a marker naming this exact round and attempt, and its live head still equals the stored head. A target with an interrupted `rerun` still pending cleanup is refused before that cleanup runs.
2. The new run's mode equals the old run's mode, checked against the old run ledger before anything opens the new run.
3. The old run is active, in the same repository, and the marker's exact batch still denies as `budget-exhausted`. The round's evidence on disk must be fully covered by what the old key reserved, including a pending gate panel round's lens and vote artifacts; if not, the old run is finalised and failed closed and the carry aborts, like a `record` that finds uncovered evidence. Only then is the new run checked with the same refusal logic `reserve` uses, for the marker's whole batch: active, not parked, not terminal for this pair, and under budget. A key with no ledger yet is checked against the supplied budget without creating the file. Finally the old run receives a terminal disposition with reason `carried` and `packet.carriedTo: { key, stateDir }`.
4. One target-ledger write binds the target to the new key, appends `{ from, to, stateDir, round, at }` to `initiative_carries`, and drops the marker. Reservations, the superseded-launch counter, and the fix counter are untouched: they still name the old key's spend for this round, and only later launches are reserved against the new key.

A crash between step 3 and step 4 is resumed, not refused: retrying the identical `carry` finds its own `carried` disposition on the old run (matched by the new key and state directory) and proceeds to step 4, even if the old run was finalised in that window. A `carry` to a different key after that crash is refused, because the old run already holds a terminal disposition for the pair.

Invariants:

- Lock order is fixed: the target lock first, then at most one run lock at a time. The two run locks are never held together.
- A target carries at most once per pair.
- The new run opens with zero launches and zero rounds; it charges only for what it does itself.
- `round-start`'s resume path reuses any artifact whose content hash still matches the ledger, regardless of which key is bound, so completed work survives the carry.

## Rationale

- Enforcing at evidence acceptance keeps native drivers on their host's own subagent mechanism. Spawning native reviewers from code, as the Codex runner does, would give a physical gate but replaces the host's subagent mechanism with a process runner and is a separate product. A pre-launch hook cannot cover Copilot, which exposes none, and a Claude subagent hook does not see reviewers launched from a shell.
- Reserving each launch of a fan-out individually would let concurrent lenses and votes deny each other on lock contention and could leave a fan-out half granted, so batches are reserved as a unit.
- Keying the run ledger by revision pair keeps the terminal refusal a plain equality check and keeps budget accounting global per key, which is the bound the budget exists to enforce. The cost is weaker same-ref traceability, mitigated by recording the ref on every target and disposition.
- Rejected for revision pairs: reopening the old target on a new revision (it erases the evidence that the earlier pair was reviewed and lets a terminal pair be reviewed again by changing nothing); keying only by ref and resetting on a revision change (the refusal would depend on mutable heads and would not survive a base change); making the per-ref target ledger per pair (verbs after `round-start` receive only the ref, so head and base would have to be threaded through every verb, and unkeyed behavior would change).
- Budget exhaustion is not an error disposition. An error records an execution defect and carries its durable continuation, which may require terminal handoff; an exhausted budget is a decision for a human. The same reasoning applies to `carry`.
- `carry` rather than restart: treating the blocked round as spent throws away accepted review work to recover from a budgeting accident and makes the new key pay twice. Taking the carried role and count from the caller would let a typo carry the wrong batch, so the marker is the only input. A new run-ledger field for cross-run provenance would need a schema bump; reusing the disposition shape with a `carried` reason needs none.

## Residual exposure

- Reservation is a contract with the native driver, not a physical barrier. A host that launches without reserving spends compute the budget never sees; its output is rejected and the run fails closed, so the overrun is bounded to one round of work.
- Reservation matches artifacts to a role and round, not to a specific launch: a fabricated artifact in a reserved role is indistinguishable from a real one. The ledger bounds cost, not honesty. A reviewer spawned outside the driver is not charged and its output is not accepted.
- The target-ledger lock is never reclaimed automatically; an orphaned lock requires operator cleanup after confirming no runner owns it.
- Run-lock stale recovery by pid is meaningful only on one machine; a lock created by another host sharing the state directory looks dead locally. Pid reuse can make a dead holder look live, and the operator removes the lock by hand with the printed command. A reclaimer that dies holding the guard leaves it until it exceeds the fixed age, and removing an expired guard is the one removal that is not serialized.
- The base is resolved on every call, so a base name that moves mid-review splits that review across two pairs, each charged. An unresolvable base is stored as the name and, on a parked run, reported only after a human resolves the park.
- The runner preflight needs a readable head identity; when the head cannot be read, the refusal comes at the launch reservation, after the DoD has run. A launch with no head matches every pair of its ref and stays refused after any terminal disposition.
- While a run is parked, a fix commit in a still-running target opens a new pair, which is refused; the target stops and the run is reconciled by a human.
- After a carry, evidence acceptance for the carried round is still measured against the old key's reservations, bounded by what the old key paid. The new run's report does not show the carried round; reconstructing a carried target's history means reading both runs' reports, keyed by `initiative_carries`.
