---
name: review-and-fix
description: >-
  Use when a design document, a ticket, or a change (a branch or your own pull request) should get one independent
  review and have its findings fixed — "review this design", "이 티켓 리뷰해줘", "review and fix this branch",
  and as the review stage of ticket-to-pr. Do NOT use for someone else's pull request (use review-until-approve)
  or to answer reviews other people left on your pull request (use pr-to-merge).
---

# Review and fix

One reviewer in a fresh context reviews the target, you verify its findings and fix them, and a new reviewer rechecks the fixes. You are the caller: the session that wrote the target or is delivering it.

Nothing here ends your run. When a reviewer cannot be started or returns nothing, try once more, then record "review not run" (step 6) and continue your workflow.

The reviewer runs the project's commands in your environment. Use this skill only for work you or the user own; a pull request by an author the user does not trust goes to `review-until-approve`.

Invoking this skill authorizes: fixes in the target, commits on your own branch, the record on the ticket and the pull request, and one follow-up ticket for minor points. When the caller asks for the outcome to be returned, write nothing to a ticket, a pull request, or the tracker: return the record and the follow-ups in your result.

## 1. Identify the target

| You were given | Target kind |
|---|---|
| A path to a design or specification document | Design document |
| A ticket URL or key | Ticket |
| A branch, a pull request of your own, or nothing (the current branch) | Change |

For a change, fix two commits now: the head, and the base, which is the merge base of the head with the branch the pull request targets or will target. Fetch first, and use the commit hashes from here on.

## 2. Write the review request

Give paths and commands wherever they exist. Text that exists only in your conversation, or in a tracker no command can print, is saved to a file among your working documents, and you give that path. Copy nothing else. Fill every row, and write "none" or "unavailable" where that is the truth.

```
Target kind: <design document | ticket | change>
Target: <path | ticket URL or the command that prints it | `git -C <repo> diff <base>...<head>`>
Must satisfy: <design document: the ticket or brief it answers | ticket: the design it implements and its parent ticket | change: the ticket's acceptance criteria and plan, and the design document — as paths, URLs, or commands>
Related repositories:
- <local path> — <what connects it: submodule pin, package version, shared format, API>
- <name> — unavailable (no local checkout)
Evidence: <test command, the commit it ran on, the result; or the code and measurements a document's claims rest on>
Not done: <what you did not check or could not run>
Focus (optional): <risks to examine first; the review still covers the whole target>
```

Find the related repositories from the project's rules file, the repository's submodules and dependency manifests, and the ticket. Leave out your reasoning, your conversation, and your opinion of the target.

## 3. Start the reviewer

Start one subagent of your own harness in a fresh context, on the most capable model class the harness offers, and wait for it with one blocking wait.

- Where the `reviewer` agent definition is available (Claude Code: agent type `concord:reviewer`), start it with the review request as its whole prompt.
- Otherwise the prompt is the content of `references/reviewer.md` next to this file, followed by the review request.
- Under Codex, only when no subagent can be started, run one separate Codex process in the same checkout, with these flags exactly: `codex exec --cd <checkout> --sandbox workspace-write --skip-git-repo-check "<prompt>"`.
- Never start another vendor's agent.

The result has three parts: **Findings** (each with a severity of `blocker`, `should-fix`, or `minor`, a location, a reason, and evidence), **Unverified** (what it could not check and why), and **Covered** (what it read).

## 4. Verify and fix

1. Check each finding against the code or the documents before acting on it. Reject a wrong finding and keep the evidence for the record.
2. Fix every accepted `blocker` and `should-fix`. For a change, commit the fixes in ordinary commits.
3. Fix a `minor` when the fix is small. Collect the other minors into one follow-up ticket in the project's tracker, or return them when the caller asked for the outcome to be returned.

A finding that needs a choice changing the acceptance criteria, the scope, or the design is a product decision: put it to the user with the options and your recommendation, and go on with the findings that do not depend on it.

## 5. Recheck

Skip this step when no fix was made for a `blocker` or `should-fix`.

Start a new reviewer, as in step 3, with a recheck request:

```
Recheck. Do not repeat the broad review.
Target: <as before, with the new head for a change>
Findings and decisions:
- <finding> — <fixed in <commit> | rejected because <evidence> | moved to <follow-up ticket>>
Check: whether each fix resolves its finding, and whether a fix introduced a defect in the lines it touched.
```

- The recheck reports a `blocker`: fix it and run one more recheck. After the second recheck, stop rechecking whatever it reports.
- The recheck reports a `should-fix`: fix it. No further recheck is needed for it; say in the record that the fix was not rechecked.

When a later merge of the base changes lines the review covered, ask for a recheck of those lines in the same form. A base that moved without touching them needs nothing.

## 6. Record

Write the outcome where the work's state lives, or return it when the caller asked for that. Nothing else is stored.

- **Ticket:** a comment with the reviewed commit (or the document and its commit), each finding with its severity and what was done about it, any fix that was not rechecked, each rejected finding with its evidence, and the unverified items. For a design document, the comment goes on the ticket the document belongs to.
- **Pull request body**, when there is one: the same summary.

If a `blocker` is still open, keep the pull request a draft (or leave the design or ticket unapproved), list the open finding in the record, and go on with work that does not depend on it.

Tell the user in a few lines: the findings by severity, what was fixed, what was rejected, what is unverified, and what remains open.

## What this skill does not do

- It does not run the test suite as a gate. Run the checks your workflow requires yourself; CI runs on the pull request.
- It does not decide whether a pull request may merge.
- It does not start a second broad review. Run one only when the user or a coordinating session asks, with a new reviewer and the same request.
