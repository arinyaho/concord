# Initiative review runs

An initiative review run bounds the review work of one initiative with one durable budget. An opt-in run supplies an opaque run key, a canonical initiative state directory, and immutable launch and round budgets. Every review launch under that key, across every target and every distribution (the Codex runner and the native Claude and Copilot drivers), is reserved against the same run ledger. With no run key, target-local accounting, `reset`, and `rerun` behave as they do for any standalone review.

The delivery mode (`base` or `lite`), escalation, and the `initiative-to-prs` workflow are described in the [initiative delivery modes design](initiative-delivery-modes.md). The completion report rendered at finalise is described in the [initiative completion report design](initiative-completion-report.md).

## Run ledger

The run ledger is `initiative-review-<sha256(key)>.json` in the initiative state directory. It is schema version 5; a ledger of any older version is rejected, never upgraded, so a replay never infers terminal state, a resolved base, or a mode from fields the ledger does not state.

The ledger contains no key, prompt, source text, artifact path, environment, or credential. It may retain raw target refs and base/head revisions for local audit and reconciliation handoff only. Project aggregates and external tracker or PR output use SHA-256 target IDs and aggregate counts only.

The execution root and the state directory are canonicalized through their nearest existing ancestor before the runner derives paths, evaluates Git ignore rules, or opens a ledger. Git-ignore validation applies only when that canonical root is a Git worktree, and it checks the actual hashed ledger path.

The per-ref target ledger stays the source of review findings. With a run key, the launch and round budgets are immutable: `reset` or `rerun` of a target ledger cannot alter them. The CLI flags `--initiative-run-key`, `--initiative-state-dir`, `--initiative-max-launches`, and `--initiative-max-rounds` must be supplied together and are validated and opened by the same code for every distribution; reopening a run compares the supplied budgets with the stored ones.

## Broad claims across attempts

A broad-sweep claim establishes ownership, not completion. When a new attempt of the same target reaches the claim path, an existing claim for a different attempt stops `round-start` with an explicit prior-attempt reconciliation error. A denied claim must not silently disarm that target's required broad review. The claim, archived attempt and cumulative budgets remain intact; this stop does not authorize reclaiming a running executor, changing keys, resetting ledgers or replenishing budgets.

| Existing claim and event | Result | Evidence |
|---|---|---|
| No claim; first armed round | Claim the sweep and require gate artifacts | Existing claim and initiative tests |
| Same target and attempt; resume | Retain ownership and require gate artifacts | `unfinished-broad-claim.test.js`, each packaged CLI |
| Same target, different attempt; no reusable completed pass | Stop before silently disarming the gate; preserve the old claim, archive, launches and rounds | Discriminating red/green in `unfinished-broad-claim.test.js`, each packaged CLI |
| Completed pass eligible for existing front-pass reuse | Reuse recorded evidence before reaching the claim path | Existing `review-cli.test.js` completed-front-pass tests |
| Different target under the same initiative | Existing one-sweep policy remains unchanged | Existing claim and initiative tests |

This is a conservative stop, not automatic recovery. A completed pass that is ineligible for existing reuse (for example because its intent must be re-evaluated) also requires reconciliation rather than an inferred waiver. Claims written by earlier versions need no migration: they already identify the target and attempt. This change does not repair prior false clean results or establish completion for a different target's claim.

## Launch reservation

Each reviewer, fixer, panel lens, and panel vote reserves one launch through an exclusive filesystem lock before it is spawned. A started, unknown, unsupported, malformed, or incomplete launch outcome remains charged; a reservation whose launch never happens also remains charged unless a trusted programmatic driver records eligible pre-turn environment failure evidence. Lock contention and exhausted budgets deny the launch, so separate worktrees cannot race for a final slot.

### Trusted pre-turn environment failures

A programmatic driver may report one observed launch lifecycle with `launch-outcome <ref> <json>`, where the closed JSON object is `{ "reservationId", "invocationId", "provider", "lifecycle", "reason", "failed" }`. The driver assigns independent opaque accounting identities: a reservation ID uses a random 32-hex nonce and ordinal (`<nonce>:<index>`), and an invocation ID is a UUID. These identities are not derived from the grant token. The private target ledger maps a grant token to its reservation ID; the shared initiative ledger stores the reservation ID and never stores the grant token. The IDs bind the outcome to its role, target, attempt, round, and revision; outcomes append to the run ledger and cannot be overwritten. Only trusted transport observations qualify: an explicit supported-Codex-schema rejection before a turn starts, or a trusted pre-spawn `ENOENT`, `EACCES`, or `EPERM` / unusable-executable result. Eligible outcomes refund the reservation, but do not remove it from attempted counts. Agent or reviewer assertions are not evidence. Native agent-tool transports without reliable lifecycle observations remain charged, and their prompts must not ask agents to guess or submit receipts. Unknown lifecycle, unsupported providers, malformed or truncated streams, and legacy reservations without identities remain charged. No launch is retried automatically; any retry needs a new reservation.

Refunds are capped at three consecutive environment failures per run. The third latches `environment-failure-limit` and refuses further launches; a new key, explicit resume, or budget/round reset does not clear it. Only a trusted started outcome resets the streak, and a later parallel success cannot clear an already-latched stop. Public run counts distinguish charged launches, attempted launches, refunds, and environment failures; receipts contain no raw provider text. The launch budget and round budget remain unchanged by a refund.

### Codex runner

The Codex runner spawns its reviewers from code, so it reserves each launch itself immediately before spawning it. The reservation is a physical gate.

The initiative state directory is not a writable root of any reviewer sandbox: a reviewer that could write the run ledger could rewrite reservations or dispositions, which would void the gate. Every verb that writes the ledger therefore runs in the parent driver, and each reviewer prompt, native or Codex, states that the reviewer runs only read-only verbs, never passes `--initiative-*` flags, and never reports a driver verb as `blocked`. Adding the directory as a writable root was rejected for that reason; moving the ledger write into the driver is already the runner's design, so the fix is the prompt clause, not a launch argument. Keyed and unkeyed launches use the same sandbox arguments.

### Native drivers: enforcement at evidence acceptance

Native reviewers, fixers, panel lenses, and votes are spawned by the host model following the driver prose, not by code. The CLI sees only the artifacts they leave behind, so it cannot prevent a launch. The guarantee is instead that an unreserved launch cannot produce accepted evidence.

- The driver calls `reserve <ref> <role> [--count N]` before each launch or fan-out and launches only after `granted`. Roles are `correctness`, `verify`, `plan`, `intent`, `gate-review`, `gate-verify`, `fix`, `certify`, `lens` (the five panel lenses as one batch), and `vote` (a multiple of three).
- A batch is reserved under one run-ledger lock in one write: it is granted or denied as a unit, and a denial consumes nothing. `reserve` reports the cause as `reason` (`budget-exhausted`, `target-terminal`, or `inactive` when the run is finalised, its ledger is missing, or the round or count is invalid; absent for contention), and answers `reconciliation-required` as its status when the run is parked and the launch would open a new revision pair.
- A granted reservation stores a random token in the target ledger only and prints it to the driver. The token is an opaque receipt: matching uses role, round, panel round, and count, and never compares the token. The run ledger records role, round, and target, never an artifact path or token.
- The target ledger keeps a per-role counter (keyed by role, round, and panel round) of superseded launches, attempts whose artifact was overwritten by a later launch. `round-failure` adds one when it names a gate artifact role (`correctness`, `verify`, `plan`, `intent`, `gate`, or `gate-verify`). Evidence is accepted only when the reserved count covers the accepted launch plus every counted superseded launch, so a retry needs a fresh `reserve`. An incomplete semantic plan rejection also supersedes its plan launch once, before a fresh planner reservation. The counter lives in the target ledger only.
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
- A keyed rerun checks for an existing terminal target before `round-start` and returns the stored safe aggregate only when the target and its full pair match. On resume, the base comes from the per-ref ledger (`target.base`), never from a stored disposition, which would compare a pair with itself. A repository ref whose ledger records no base fails closed before identity work when the run holds a terminal or escape disposition for it, and otherwise proceeds to `round-start`, which refuses a repository ref that has neither a base argument nor a recorded base. A stored disposition with no head, or no base for a git ref, matches no revision: it neither replays nor blocks a new pair.

## Disposition journal

Every terminal runner result is normalized into one durable disposition: `terminal`, `error`, or `escape`. A terminal disposition is the only replay and identity authority; error and escape entries are retained for audit but do not suppress a later retry. Duplicate dispositions are ignored under the ledger lock.

Retaining an error disposition does not authorize retry by itself. Its continuation packet reflects the target ledger's bounded recovery state: actionable work uses `resume`, while exhausted or terminal planner execution failure uses `terminal-handoff`. Canonical provider diagnostics preserve classification without raw credentials. See [failed planner provider recovery](planner-provider-recovery.md).

Canonical provider messages can repeat across distinct provider attempts. The runner binds error deduplication and packet lookup to the same internally generated per-launch UUID, bounded round, attempt state and continuation identity; a later attempt appends a new audit entry with its own budget snapshot and delivery claim. Provider-returned metadata cannot select that UUID. An earlier entry and its delivery state are preserved, while repeated delivery of the same occurrence and generic harness errors remain idempotent.

- `escape` covers `record`'s re-runnable stop states, `gate-pending` and `intent-review`, where a human dismisses or resolves the reported finding and a fresh `round-start` clears it, plus a literal `escape` decision. A material finding (every parked intent finding, or a design-conformance or AC-coverage gate finding) always carries a reconciliation, which takes precedence and stays `terminal`, so these states land as `escape` only when the open finding is non-material.
- `error` is a harness or runner failure (a thrown exception).
- Every other outcome (converged, parked, abandoned, or a reconciliation-required target) is `terminal`.

A keyed native `record` that reaches a terminal or escape outcome writes the disposition and then checks that it is present with matching target, revision, and kind, and reason for an escape (the journal's dedupe key). If the write was contended, or only an earlier escape with a different reason is present (for example an unconsumed `intent-review` escape written by the Codex runner, which shares the journal), `record` fails with a `harness-failure` and leaves the target ledger not `done`. Re-running `record` is safe because an identical unconsumed escape is deduplicated.

Terminal outcomes follow the same privacy contract on every path: raw refs and SHAs stay in the local ledger, and public summaries carry hashed target IDs and aggregate counts.

## Reconciliation and refusals

Before fixer planning, intent findings and design-conformance or AC-coverage gate findings become reconciliation work, for keyed and unkeyed runs alike. This deliberately suppresses correctness and docreview fixers in the same round.

A run without a dependency plan keeps the conservative run-wide circuit breaker: while a `reconciliation-required` hint is held, a revision pair not yet opened is refused without charging. Pairs already opened retain their existing behavior. The Codex runner checks this before `round-start`, so a refused pair never runs the DoD or moves the per-ref ledger into gates.

To permit independent targets to continue, register the approved source index's dependency graph before the first reservation: `review-cli initiative-plan <absolute-plan.json>` with the original initiative flags. Its schema is `{"version":1,"targets":[{"ref":"feature/A","dependsOn":[]},{"ref":"feature/B","dependsOn":["feature/A"]}]}`. Every target has an explicit dependency array; duplicate targets or edges, unknown dependencies, self-edges and cycles are refused. The private run ledger stores the normalized plan and its SHA256. Re-registering an identical plan is idempotent; changing it, or adding the first plan after a launch, is refused. The source index and reviewed contract determine dependencies; an agent must not declare independence merely to bypass a hold.

With a plan, a pending reconciliation blocks every future reservation for its target and all transitive dependents, including already-opened pairs. Already-running workers may finish; no new dependent launch is authorized. A known independent target continues under the same key and remaining budget. An unknown target, or a held target absent from the plan, stays blocked. Concurrent registration and reservation serialize on the same run lock.

A human decision that keeps the approved contract uses `review-cli reconcile <target> --claim <exact-delivery-claim> --by <human> --decision <verbatim-human-words> --contract unchanged` with the original initiative flags. The existing run must be active and hold that exact target/claim. The command appends an attributed entry to `reconciliationDecisions`, resolving only that occurrence; stale, repeated, wrong-target and incomplete decisions are refused. Other holds remain effective. Dispositions, launches, refunds, round history and budgets are preserved. The command records an operator-supplied human decision, like `dismiss`; a claim and `--by` are not cryptographic proof of identity. Drivers require direct human authorization and must not invent acceptance text. A changed contract requires the existing human-authorized new-run procedure.

Native terminal recording binds each reconciliation to `{attemptId,round}`. Retrying a resolved occurrence returns its original claim; a later round at the same head may create a distinct hold, which an old claim cannot release. A legacy disposition without occurrence data remains conservative for the old pair after a decision; a new revision may proceed. Ordinary terminal outcomes remain final. Raw decision text, dependency refs and provenance stay in the private ledger; public reports retain their aggregate allowlist.

| State and event | Result |
| --- | --- |
| No plan; new pair while a reconciliation is pending | Refuse without charging |
| Planned target is independent of every pending hold | Allow within the unchanged budget |
| Planned target is held, dependent, or unknown | Refuse every new reservation without charging |
| Exact pending claim plus an attributed unchanged-contract decision | Append the decision; retire only that hold |
| Stale claim, changed contract, or malformed decision | Refuse without changing the run |
| Resolved occurrence replay | Return its original recorded outcome |
| Later occurrence at the same pair | Record a new claim and hold |

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
