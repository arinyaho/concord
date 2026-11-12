---
name: review-and-fix
description: >-
  Use when a design document, a ticket, or a change (a branch or your own pull request) should get one independent
  review and have its findings fixed — "review this design", "이 티켓 리뷰해줘", "review and fix this branch",
  and as the review stage of ticket-to-pr. Do NOT use for someone else's pull request (use review-until-approve)
  or to answer reviews other people left on your pull request (use pr-to-merge).
---

# Review and fix

One reviewer in a fresh context reviews the target; you verify its findings and fix them; a new reviewer rechecks the fixes. You are the caller: the session that wrote the target or is delivering it. The decisions behind each step are in `docs/design/independent-review.md`.

Nothing here ends your run. If a reviewer cannot be started or returns nothing, try once more, then record "review not run" where the record goes (step 6) and continue your workflow.

## 1. Identify the target

| The user or the calling workflow gave | Target kind |
|---|---|
| A path to a document under `docs/` or another design or specification file | Design document |
| A ticket URL or key | Ticket |
| A branch, a pull request of your own, or nothing (the current branch) | Change |

For a change, fix the two commits now: the head, and the base it is reviewed against (the pull request's base branch, or the repository's default branch on the remote, fetched). Use the commit hashes from here on.

## 2. Write the review request

Give paths and commands. Never copy the target into another file. Fill every row; write "none" or "unavailable" where that is the truth.

```
Target kind: <design document | ticket | change>
Target: <path | ticket URL or the command that prints it | `git -C <repo> diff <base>...<head>`>
Must satisfy: <the ticket's acceptance criteria and plan, the design document, the brief — as paths, URLs, or commands>
Related repositories:
- <local path> — <what connects it: submodule pin, package version, shared format, API>
- <name> — unavailable (no local checkout)
Evidence: <test command, the commit it ran on, the result; or the code and measurements a document's claims rest on>
Not done: <what you did not check or could not run>
Focus (optional): <risks to examine first; the review still covers the whole target>
```

Find the related repositories from the project's rules file, the repository's submodules and dependency manifests, and the ticket. Do not include your reasoning, your conversation, or your opinion of the target.

## 3. Start the reviewer

Start one subagent from the `reviewer` agent definition with the review request as its whole prompt. It runs in your environment. Wait for it with one blocking wait.

Its result has three parts: **Findings** (each with a severity of `blocker`, `should-fix`, or `minor`, a location, a reason, and evidence), **Unverified** (what it could not check and why), and **Covered** (what it read).

## 4. Verify and fix

1. Check each finding against the code or the documents before acting on it. Reject a wrong finding and note the evidence.
2. Fix every accepted `blocker` and `should-fix`. For a change, commit the fixes in ordinary commits.
3. Fix a `minor` when the fix is small. Collect the other minors into one follow-up ticket.

A finding that needs a choice changing the acceptance criteria, the scope, or the design is a product decision: put it to the user with the options and your recommendation, and continue with the findings that do not depend on it.

## 5. Recheck

Skip this step when no `blocker` or `should-fix` was fixed.

Start a new `reviewer` subagent with a recheck request:

```
Recheck. Do not repeat the broad review.
Target: <as before, with the new head for a change>
Findings and decisions:
- <finding> — <fixed in <commit> | rejected because <evidence> | moved to <follow-up ticket>>
Check: whether each fix resolves its finding, and whether a fix introduced a defect in the lines it touched.
```

If the recheck reports a `blocker`, fix it and run one more recheck. After the second recheck, stop rechecking whatever it reports.

## 6. Record

Write the outcome where the work's state lives:

- **Ticket:** a comment with the reviewed commit (or document version), each finding with its severity and what was done, and the unverified items.
- **Pull request body**, when there is one: the same summary.
- **Design document or ticket as target:** the fixes are the edits themselves; the comment goes on the ticket the document belongs to.

If a `blocker` is still open, keep the pull request a draft (or leave the design or ticket unapproved) and list the open finding in the record. Then continue with any work that does not depend on it.

Tell the user in a few lines: how many findings by severity, what was fixed, what was rejected, what is unverified, and what remains open.

## What this skill does not do

- It does not run the test suite as a gate; run the checks your workflow requires yourself.
- It does not decide whether a pull request may merge.
- It does not start a second broad review. Run one only when the user or a coordinating session asks, with a new reviewer and the same request.
