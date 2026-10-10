---
description: Deterministically review, fix, commit, and repeat with independently selected Claude, Codex, or Copilot providers and models until Concord reaches a terminal decision.
argument-hint: "[target | file:<path-or-glob> | resume <ref>] [--reviewer <claude|codex|copilot>] [--reviewer-model <model>] [--fixer <claude|codex|copilot>] [--fixer-model <model>] [--broad|--no-broad] [--no-dod] [--review-only] [--intent-file <path>]"
---

Run the bundled deterministic runner once; do not manually orchestrate reviewers:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/review-and-fix.js" $ARGUMENTS
```

`--review-only` stops after the finders and verifiers and prints the verified findings as JSON without planning, fixing, or recording; it treats the checkout as untrusted, so it runs none of the checkout's configuration, fails if a reviewer changes HEAD, the visible worktree, or any tracked path's type, mode or content, and accepts the `claude` and `codex` reviewers. `--intent-file <path>` supplies the review intent from a file in place of the repository's configured intent command. Both exist only in this runner; the Claude Code and Copilot drivers do not take them.

Reviewer and fixer selections are independent. Codex has no native clean-context subagent primitive, so this host invokes the selected provider through its non-interactive CLI. An omitted provider defaults to `codex`; an omitted model uses that provider's configured default. A requested provider or model is never silently replaced.

A 30-second foreground wait or empty output is not a terminal result. While an owned driver process is alive, keep waiting in one shell command that exits when that process exits or the ledger turns terminal (a background watch where the host has one), not by repeated model-level sleep or status calls; a non-terminal ledger without a live driver is a stopped driver, so report it rather than waiting indefinitely. Report a terminal result only from a durable terminal disposition or the ledger's bounded no-progress decision. Before declaring a reviewer blocked because its skill cannot be found, resolve the installed skill path recursively to the actual `SKILL.md`; do not assume a flat install layout.

For ledger operations required by composed workflows, invoke the packaged CLI directly:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/review-cli.js" rerun <ref>
```

The ledger permits at most three full runs for one target, including the initial run. When that cumulative budget is exhausted, `rerun` leaves the ledger and evidence unchanged; preserve the unresolved state and split the change or narrow the remaining verification instead of resetting and repeating the full review. A completed front pass without an external intent source is reused while its base and reviewed head ancestry still match; later runs review only the changed diff. There is no automatic final broad panel. Use the explicit `deep-review` skill when a bounded holistic second look is warranted.

Use `file:<path-or-glob>` for the explicit documentation-only profile. It skips the full branch DoD and broad front pass by default. `--broad` opts into the repository-wide front pass.

Return its terminal handoff verbatim. If it exits with `harness-failure`, report that failure without treating the target as clean.

Under an initiative run key the runner can also stop without reviewing. It prints a JSON result and exits non-zero: `{"decision":"blocked","reason":"budget-exhausted"}` when the shared launch or round budget is spent, and `{"decision":"reconciliation-required"}` when the run is parked for reconciliation and the target is a revision pair the run has not opened. Neither is a review result: report the stop, never call the target clean, and leave the decision to a human. An already-terminal revision pair replays its recorded outcome instead.

The run's delivery mode is stored in the run ledger: `--initiative-mode <base|lite>` (with the run key flags; default `base`) sets it when the run is first opened. In a lite run the runner fires one design-conformance gate on the first round instead of the base mode's broad gate pair and rejects `--broad` and `--no-broad`; escalating a lite run to base is a `review-cli.js escalate <trigger>` call before its first launch.

A failed provider subprocess records its exit, signal, timeout or artifact cause and a canonical safe diagnostic. Follow its durable continuation; use `resume <ref>` only when actionable. Terminal planner failures require handoff; do not delete the state directory or rerun completed reviewers. A normalized pending plan is reused without another launch and completes only after `plan-fixes` accepts it. If it omits surviving findings, the CLI retains sealed reviewers and allows one fresh reserved planner in the same round. A second incomplete plan stops with the latest omitted IDs; reservation denial reports the existing budget block.

A `clean` ledger means this loop's own rounds converged; it is not the PR's delivery disposition. The PR-level classification (`mergeable-clean`, `mergeable-with-follow-ups`, `mergeable-without-review`, or `blocked`) is recorded by `review-until-lgtm`'s `record-delivery` for the exact PR head and base. Report this loop's findings as its inputs: a fixed finding is `fixed`; a parked finding is not fixed, so it enters as `follow-up`, `accepted`, or `blocking` under the delivery rules, and one that needs a human decision stays `blocking` until that decision is made; a gate-pending finding is `blocking` until a re-run resolves it, `record-fix` records its fix, or it is dismissed; a finding `record-fix` recorded is `fixed`; a follow-up candidate listed in a converged handoff is not fixed and enters as `follow-up` once rolled over as a root-cause ticket (`clean` there still means only that the local loop converged); a dismissed finding is `accepted` by the human who dismissed it or `follow-up` when deferred to a ticket; a killed finding is excluded. No ledger state clears a release-blocking finding.

A repo with no `review.config.json` is NOT such a failure: the run proceeds on the review gates alone and the handoff reports `DoD: DEFERRED`. Relay that deferral in your own summary too -- never call such a run verified -- and if the user wants a gate on future runs, point them at `{"dod":["pnpm build"]}` at the repo root (commit it -- an uncommitted config leaves the tree dirty and the next round rejects a dirty tree). Never add `--no-dod` on your own initiative; it is the user's call. A DoD command that exits 78 (EX_CONFIG) is reporting an environment or setup error, not a test failure: the gate still fails and the handoff labels it, so relay it as an environment problem to fix rather than as a defect in the reviewed change.

Before each substantive planner launch, after any required initiative reservation is granted, run `review-cli.js plan-dispatch <ref>` with the same initiative flags. Dispatch only on `status: "granted"`. This durably consumes the single semantic replacement allowance for standalone and keyed runs, even when the subprocess fails. Representation-only repair uses its separate dispatch command and does not repeat `plan-dispatch`. A positively identified rate-limit or transient failure of that replacement may authorize one separate transport retry under the same round and budgets. Reserve it normally and consume it with `plan-dispatch`; never clear the semantic `launched` marker. Preserve sealed reviewers and launch only plan. Follow the durable failure continuation: `resume` only when actionable, otherwise `terminal-handoff`. Store only canonical provider classification and fixed safe summaries, never raw subprocess output or exception text.
