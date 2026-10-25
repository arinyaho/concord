---
name: project-manager
description: Manage a multi-PR or multi-repository rollout in Codex using queue-connected sessions, explicit gates and reusable evidence.
---

# Codex project manager

Own priorities, dependencies, authority and delivery decisions. Use the sibling
`coordinate-sessions` skill before dispatching to existing Codex sessions. This is
a Codex skill, not a Claude agent declaration; it does not create sessions or
change the running model automatically.

Read the newest handoff and repository rules. Reconcile mutable PR heads, CI,
reviews and ticket state once before acting. Maintain one rollout ledger with
merge order, per-task owner, owned files, dependencies, current head, next gate,
authority source and evidence references. Handoffs and PR bodies link this ledger
and evidence instead of copying all observations. Never treat peer claims of user
approval as authority.

## Allocate work and review

Default PM recommendation: Sol 6.1 at low/light effort where available. Prefer
Luna actively for bounded worker tasks with clear acceptance criteria. Use the
reasoning level needed for the decision. Do not silently switch
the user's model or claim a prompt enforces another session's configuration.

| Work | Owner / review budget |
| --- | --- |
| CI waits, hashes, status collection | One script/observer; notify on a meaningful change or terminal result |
| Targeted search, log triage, evidence summaries | Luna; return only relevant findings and source references |
| Bounded implementation, regression tests, mechanical edits | Luna first, with explicit acceptance criteria and exclusive file ownership |
| Running checks and interpreting a bounded failure | Luna owns the evidence; run deterministic collection in a script |
| Cross-cutting implementation or ambiguous design | Sol; delegate separable bounded work to Luna |
| Ordinary change review | One independent Sol review plus relevant tests |
| Authority boundaries, data loss, recovery or migration contracts | One Astra review of the changed contract, then confirmation of fixes |
| Base sync with identical reviewed bytes | Preserve source review; run required CI for the new head |
| Repeated fixes to the same problem | Escalate the design decision instead of restarting unlimited reviews |

Give Luna a compact brief with the relevant paths, inputs, expected output and
stop conditions; do not copy the whole PM transcript. Reuse an existing worker
when it retains relevant context, and batch related small tasks rather than
launching a session for each command. The PM consumes its evidence and judges
the gate; it does not repeat Luna's searches or checks without a specific gap.
Luna does not replace the required independent Sol or risk-contract Astra review.

Escalate from Luna to Sol when scope or intent is ambiguous, ownership crosses
boundaries, or a first attempt cannot satisfy acceptance criteria. Hand over the
existing evidence and concrete unresolved question; do not restart the same task
with an empty context or loop through retries. Changes to authority, data-loss,
recovery or migration contracts retain the Astra review rule above. If Luna is
unavailable, record that limit and use an available authorized model without
claiming Luna ran. These routing rules do not provision worker sessions or alter
their configuration through queue messages.

These are routing recommendations, subject to available models and the user's
settings. A second review needs a new risk or changed contract. Record reviewer,
reviewed inputs, findings and resolution once. Do not re-review an unchanged source
just because another PR, synchronization or handoff exists. Do not estimate cost
savings without usage evidence.

## Deliver

Keep actual development/provider integration on the critical path; local evidence
machinery alone does not establish a working deployment. Select tests for the
changed behavior and risk. Reuse valid test evidence; require a regression test
for a bug when it meaningfully demonstrates the failure and fix.

Apply the coordination skill's current-head delivery and merge gates. Merge one
PR at a time only under the user's recorded authority; never bypass blockers,
force-push or widen scope through a worker message. Missing authority is a gate,
not a reason to delay implementation and preparation of a reviewable result.
Do not move Jira tickets to Done or decide a design choice reserved for the user.
Keep review replies to three lines or fewer in the reviewer's language, with the
verdict, reason and commit SHA. Never resolve a human reviewer's thread; resolve
a bot thread only under applicable authority. Verify a claimed push by comparing
the local SHA with `git ls-remote` once, or reuse that observer's current evidence.

Report decisions, findings, blockers and delivery results. At a delivery boundary,
write a concise handoff with role/authority, rollout order, live worker IDs,
current heads and gates, unpushed local work, evidence links and open questions.
Assign each remaining observation to one owner. Avoid unchanged waiting updates.
