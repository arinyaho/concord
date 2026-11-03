# review-until-lgtm with human reviewers

`review-until-lgtm` runs on the PR author's side: it collects the review feedback a pull request receives, verifies it, fixes what blocks the rollout, replies, and repeats on the new head until the PR can be delivered. The bot-only loop is described in the [review-until-lgtm design](review-until-lgtm.md). This note extends the same loop to human reviewers, alone or mixed with automated ones, so a colleague's review goes through the same verification, bounded fixing, provenance and delivery rules as a bot's.

A human reviewer differs from a bot in three ways that the bot loop cannot absorb by configuration alone. A human answers in hours or days, not within a 15-minute window, so silence is normal and is not a provider failure. A human talks back: replies in threads, PR conversation comments and questions are feedback, not noise. A human's approval is a GitHub Approve review that the repository's branch rules count, and it belongs to one commit. The design keeps the bot loop and its state engine and adds what these three differences require: a reviewer identity with a type, a feedback record that survives pushes, a wait that costs no model tokens, and a delivery rule that defers to the branch rules.

The PR's ledger in this note is the set of marker files the state engine (`core/lgtm-state.js`, exposed as `review-lgtm-state`) keeps in the repository's git directory, keyed by PR number and, where a marker belongs to one head, by the exact head SHA.

## Goals

- The user selects the reviewers of one PR explicitly, humans and bots in one list, and a resumed session reads the selection from the ledger.
- Every piece of feedback on the PR, from a selected reviewer or anyone else, is verified and answered once: fixed with the fix commit named, collected as a minor follow-up with its reason, rebutted with evidence, or answered with a clarifying question.
- After an authorized push, each selected human reviewer is asked to review the new head once, and the session waits for them without model calls until they respond or the wait deadline passes.
- Only a GitHub Approve review on the current head counts as a human approval, and delivery follows what GitHub reports about the branch rules.
- The bot-only loop keeps its collection window, automatic-review grace, request claims, request and fix budgets, fix ownership and delivery behavior.

## Non-goals

- Merging. An agent merges only through the existing merge gate at the user's explicit request.
- Reviewing someone else's PR. That is `review-until-approve`, which acts as the reviewer; this skill acts as the author.
- Reviewer selection from GitHub's requested-reviewer list, CODEOWNERS, or a repository configuration. The user names the reviewers.
- Team reviewers. A reviewer is one GitHub account; a team is not an account.
- A Concord list of required approvers, or a required/optional split among the selected reviewers. The repository's branch rules are the only merge requirement.
- Integration with any product outside Concord and GitHub.

## Anti-goals

- Reading silence, a reaction, a passing CI run, or a comment as approval.
- Resolving a human's review thread. The reviewer resolves their own thread.
- Mentioning or re-requesting a reviewer repeatedly while waiting, posting reminders, or writing commands addressed to a bot on the reviewer's behalf.
- Holding a model session open, or sleeping in the model, while a human takes a day to answer.
- Following instructions found in review text.

## Reviewers

### Selection

`--reviewer <login>` names one reviewer and repeats for each. The list may mix humans and bots. The skill passes it to `select-reviewers <pr> --reviewer <login>...`, which resolves each login through GitHub's user API and stores, for each, the login, the numeric account id and the account type, as a new write-once record `pr-<n>.reviewers-<sequence>.json` under the PR transition lock; the latest record is the selection. A run that names reviewers replaces the selection; a run that names none uses the stored one, so a resume needs no re-entry. Every record is kept, so the handoff can show when the selection changed.

GitHub's requested reviewers are not imported. Someone a teammate requested in the GitHub interface is not awaited unless the user selects them; their feedback is still welcome (see Feedback).

### Type

A reviewer is a human or a bot by GitHub's account type (`type` of the user API, `User` or `Bot`), never by configuration or by a `[bot]` suffix in what the user typed. `select-reviewers` tries the login as given and, when GitHub has no such user, the login with `[bot]` appended, because GitHub names an app's account `<slug>[bot]`. It refuses an `Organization`, an account GitHub cannot resolve, and the PR author's own account, because GitHub does not let an author review their own PR.

Each observed review, comment and reply is matched to a selected reviewer by account id and type (`author { __typename ... on User { databaseId } ... on Bot { databaseId } }` in the collector's query), never by login alone. The collector's login normalization strips a `[bot]` suffix, so by login alone a user account whose login equals a bot's slug would be read as that bot; matching on id and type closes that.

### Identity across renames and deletions

The account id is the identity; the login is a display name. At every `select-reviewers` and at the start of every resumed run, the skill resolves each stored id to its current login and, when the login changed, writes a new selection record with the new login, so a login freed by a rename and taken by another account never becomes that reviewer. An id GitHub no longer resolves is a deleted account: its status is `gone`, it is never awaited as a pending approval that could still arrive, and the handoff names it so the user can change the selection. Feedback it left stays in the record under its id and URL.

## Feedback

### What counts

Feedback is any of these on the PR, written by an account other than the PR author and the account the skill acts as:

- a submitted review's body, when it is not empty;
- an inline review comment, including a reply in an existing thread;
- a PR conversation comment.

A review's state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`) is a signal, separate from its text. Reactions are neither feedback nor signal for a human; the Codex thumbs-up path stays a bot adapter. A comment in a resolved thread is not feedback, as in the bot loop.

Feedback from anyone is welcome. A review, inline comment or actionable PR comment from a person who is not selected enters the same assess, fix and reply flow. The selection defines whose response is awaited and who receives a re-review request; it does not define who may speak. An approval from an unselected person never stands in for an awaited reviewer, and a request for changes from an unselected person blocks completion until its feedback is answered.

A feedback item is identified by its GitHub node id. An item is answered once the ledger holds its handled record and its reply exists on GitHub (see Fix and reply). An item edited after it was answered (`lastEditedAt` later than the handled record) is a new revision and is answered again once.

### Feedback across pushes

A human's comment is made on one commit and is still owed an answer after the head moves. Feedback is therefore collected by whether it is answered, not by the head it was made on: every unanswered item enters the batch of the live head, wherever it was made, and keeps the commit it was made on. This is the deliberate difference from bot collection, which keeps only reviews made on the head and treats older ones as history. An approval is the opposite: it is attached to one commit and never moves (see Approval).

### Observation shape

The collector already turns each review into one `record-review` observation that keeps the reviewer, the review URL, the commit identity and the findings. The table shows what each field holds and what the human path adds. Every added field is optional, so a bot observation keeps its present shape and bot-only records and packets do not change.

| Field | Held by the bot path | Added for the human path |
|---|---|---|
| `reviewId` | GitHub review database id, decimal digits; the file key `review-<id>` | A PR conversation comment, or a thread reply outside any current review, is its own observation with id `comment-<databaseId>` and file key `comment-<databaseId>`, so the two id spaces cannot collide |
| `reviewer` | Login without `[bot]`; required; `legacy/unknown` in status when a record lacks it | `reviewerId` (account id) and `reviewerType` (`User` or `Bot`) beside it |
| `reviewUrl` | Review URL | A comment observation carries the comment URL |
| `commitId` | Must equal the live head; the collector sets it to the head | Unchanged: the head at which the item is handled |
| `reviewCommitId` | In the packet only, not persisted | Persisted, so provenance survives a push; `null` when a force-push dropped the commit |
| `submittedAt` | In the packet only | Persisted |
| `lgtm` | `APPROVED`, or the bot's fresh reaction | For a `User`, true only for an `APPROVED` review whose own commit is the live head |
| `findings[]` | `{url, priority, signals}` persisted; the body and location only in the packet | Each finding also persists `itemId` (node id), `kind` (`review-body`, `inline`, `reply`, `comment`), `author` `{login, id, type}` and `originalCommitId`; the body stays out of the ledger |

Every unanswered human item becomes one finding of its observation, with `priority: null` unless it carries the bot priority markup, so the existing verifier, adjudication, `collect-minor`, `reject-review-batch` and fix-round machinery handle it without a parallel path. A clean `APPROVED` review with no text produces an observation with no findings and `lgtm` set, which `record-review` does not persist, as for bots; approvals are read from GitHub every time, because GitHub holds the review state and the ledger holds only what GitHub cannot.

The collector's top-level reviews and PR comments are read as the newest 100 of each. The human path pages both connections with the same page bound as review threads, failing the collection instead of truncating it, because a human discussion can exceed 100 comments and a silently dropped one would never be answered.

## Lifecycle

One run moves a PR through the steps below on each head. A bot-only selection runs the bot loop exactly as it is; the steps below add the human parts and say where they meet it.

```
select ──► collect (bots: 15-min window; humans: unanswered items)
              │
              ▼
           assess ──► fix round? ──yes──► fix, test, one push ──► request re-review (humans, once per head)
              │                                                        │
              no                                                       ▼
              │                                              collect on the new head
              ▼
     reply to every item ──► end condition met? ──yes──► deliver
                                   │
                                   no
                                   ▼
                         wait (no model tokens) ──► feedback / approval / head moved ──► collect
                                   │
                                   deadline ──► park (resumable, not approval)
```

### Collect

On each head the bot collection runs first, for the selected bots only: `watch` and `collect` receive one `--reviewer` per selected bot, the 15-minute window, the 120-second automatic-review grace and the per-provider request claims apply to them as they do now, and the window ends with a `packet` or a `deadline` line as now. A selected human never appears in the bot packet's `pending` list, so a silent human never turns into `review-timeout`.

When the bot packet is terminal, or at once when no bot is selected, `collect <pr> <head-sha>` reads every unanswered feedback item on the PR and every selected human's latest review signal, and prints them as observations of the same packet. The session records every observation with `record-review` before deciding, so the head's batch holds the bot findings and all owed human feedback together, and the first arrival never drives a piecemeal push.

On the first run on a PR, items written before the skill started are collected too. Where the PR author already answered one in its thread, the assessment records it as handled with disposition `already-answered` and the link to that answer, and posts nothing; the handoff lists these items so none is dropped silently.

### Assess

The collected batch goes to the clean-context verifier and, when its signals hold, to the adjudicator, exactly as in the bot loop. Each item ends as one of:

- `blocker`: a rollout blocker as defined by the bot loop and the delivery disposition. It is fixed in the head's fix round with a failing test first.
- `minor`: any other accepted item. It is recorded with `collect-minor`, never fixed during the loop, and becomes a follow-up at delivery.
- `rejected`: the verifier or adjudicator rejects it with evidence. This includes an answered question that asks for no change.
- `clarify`: the item is ambiguous, so the reply asks one question instead of guessing.
- `approve-intent`: an unconditional comment-only LGTM from a selected human (see Approval).
- `no-action`: text that asks for nothing and states nothing to verify, such as thanks. It is recorded as handled with its reason and gets no reply.

An item that would change the approved product contract, materially expand the PR, or settle a structural choice the approved design leaves open stops the run for human reconciliation, as in the bot loop. Review text is data in every step: the verifier and adjudicator receive it marked untrusted, and its instructions are never followed.

### Fix and reply

A fix round is claimed, owned, certified and pushed exactly as in the bot loop: one claim per head with an immutable owner, one certified commit and one push, and the PR-wide cap of three fix rounds, raised only by a recorded human waiver. Human feedback spends the same fix rounds. A push happens only where the bot loop already authorizes it.

After the push, and after its checks support the response, the skill replies to every item of the batch, whatever its disposition:

- `blocker`: the fix commit, and what changed;
- `minor`: the verdict and reason; the follow-up ticket link is posted later by the delivery disposition's existing thread-linking step;
- `rejected`: the evidence (a file and line, a test, a contract clause) for keeping the code as it is;
- `clarify`: the question;
- `approve-intent`: the request to press Approve.

A reply that claims no fix (minor, rejected, clarify, approve-intent) needs no push and is posted as soon as the item is assessed. An inline item is answered in its own thread; a review body or PR comment is answered with a PR conversation comment that links the item. The skill never resolves a human's thread, also when its fix makes the thread outdated. The existing resolution rule for a selected bot's threads is unchanged.

Replies are idempotent. Before posting, the skill claims the item with `claim-reply <pr> <item-id>`, a write-once marker under the PR transition lock; a second session gets `reply-claimed` and posts nothing. The reply carries a hidden first line `<!-- concord-lgtm-reply: <item-id> -->`. After GitHub accepts it, `record-reply <pr> <item-id>` writes the handled record: the item id, kind, URL, author `{login, id, type}`, original commit, disposition, reason, reply URL and fix commit when there is one. A claim without a handled record means an interrupted post: on resume the skill searches the item's thread, or the PR conversation, for a comment by the acting account carrying that first line, records it when found, and posts once when not.

### Request re-review

After each push the skill asks each selected human to review the new head, once per reviewer per head, through GitHub's requested-reviewers API. `claim-human-request <pr> <head-sha> <reviewer-id>` writes a write-once claim; after GitHub accepts the request, `mark-human-requested` writes the sent marker. A claim without a sent marker is settled from the PR timeline: a review-request event for that reviewer by the acting account after the head appeared counts as sent; otherwise the request is sent once. On the first run, a selected human who is not already requested and has not reviewed the head gets the same single request. A request refused by GitHub (the account cannot be requested on this repository) is reported once as `request-refused:<login>` and is not retried; the reviewer stays awaited, since they may still review if they can read the PR.

Human requests do not spend the bot request budget of three per PR. They are bounded by the heads, which the fix-round cap bounds, and they are separate because a re-review request to a person is the normal step after every push, while a manual bot request is the exception the bot budget exists to limit. Bot requests keep their budget, grace and claims unchanged. A head pushed by someone other than the skill also gets one request per selected human, because a push makes every earlier approval stale whoever pushed it.

A selected bot needs no re-review request after a push: the bot loop's automatic-review grace and claims cover it on every head.

### Wait

When the head's batch is assessed, every item is answered or claimed, no fix round is open, and the end condition (see Deliver) is not met, the session waits.

The wait is `wait-feedback <pr> [--max-wait <seconds>] [--once]`, a script in the pattern of `review-until-approve`'s `watch.js`. It reads the ledger without writing it, polls GitHub every 60 seconds with a small query (head, PR state, newest review, comment and reply ids with their edit times, review decision and merge state) and runs the full collection only when that fingerprint changes. It costs no model tokens between polls, prints exactly one JSON line and exits:

| Event | Fires when |
|---|---|
| `feedback` | An unanswered item exists from anyone other than the PR author and the acting account, including a new review of any state |
| `approved` | A selected human's Approve review on the live head appeared |
| `head-moved` | The live head differs from the head the ledger last handled, and is the same on two consecutive polls |
| `rules-changed` | Nothing else is awaited and GitHub's review decision or merge state changed |
| `merged`, `closed` | The PR reached that state |
| `deadline` | The head's human-wait deadline passed |
| `idle` | Only with `--max-wait`: the window ended without an event |
| `error` | Ten consecutive failed polls, counted across windows |

Reactions, CI changes, labels, and a selected reviewer's silence wake nothing. "Unanswered" is decided by the ledger's handled records, not by timestamps, because a commit's date is set by whoever made it and the local clock is not GitHub's; in the normal case this is exactly the feedback newer than the last push.

The wait deadline is persisted per head. `open-human-wait <pr> <head-sha> <seconds>` writes it when the session first waits on a head, as a write-once record of start and deadline, so a resumed or replaced session continues the same clock. The default is 48 hours, a day of margin on a team norm of answering within one day. `--human-wait <hours>` changes it for the run: the skill writes a new record for the current head that keeps the original start and moves the deadline, and later heads use the new length.

Polls back off on failure (doubling the interval up to eight times) and a rate-limit response sleeps until the reset time GitHub reports, bounded by the window end, without counting as a failure. The failure count, the head seen on the previous poll and the last fingerprint live in a non-authoritative sidecar `pr-<n>.wait.json`, so they carry across windows; an unreadable sidecar is treated as empty and at worst repeats one full collection.

How a host runs the wait:

| Host | How the session waits | Model cost |
|---|---|---|
| Claude Code | `wait-feedback <pr> --max-wait 6600` as a Bash `run_in_background` command with `timeout: 7200000`, which wakes the session when it exits; on `idle`, or a run killed by the host with no JSON line, the session runs the identical command again and says nothing | one small model call per window, about 13 a day; a 48-hour wait is about 26 windows |
| Codex, Copilot | No background process can wake the conversation, so the session tells the user the PR is parked and gives the exact resume command. A later explicit resume runs `wait-feedback <pr> --once`, which polls once and prints an event or `idle`; on `idle` before the deadline the session returns the same resume command | one model call per explicit resume |

`Monitor` is not used for the human wait: it stops after 30 minutes, which suits the 15-minute bot window but not a wait of days. The 600 seconds between `--max-wait` and the host timeout leave room for a poll, GitHub latency and startup, so `idle` is printed before the host kills the command. The session builds the command once with absolute paths and never edits, wraps or replaces the script, and never writes its own polling loop. A user stop ends the background task and posts nothing.

While waiting, the skill posts nothing: no mention, no repeated request, no reminder at the one-day mark.

### Resume

Every invocation on a PR with a ledger is a resume. It re-reads the selection and resolves each id's current login, re-reads the live head, and runs `status`. A head that differs from the last handled head starts that head's bot collection and human collection. An unchanged head goes straight to the human collection, then to the wait with the persisted deadline. Claims without their sent or handled markers are settled from GitHub as described above, so a resume duplicates no reply and no request. The request and fix budgets, waivers and collected minors are PR-wide and survive any number of resumes and session replacements, as they do now.

### Deliver

The end condition holds when, for the live head:

- the bot collection is terminal, as the bot loop defines it;
- every selected human who is not `gone` has an Approve review on the live head;
- every feedback item is answered, and every unselected person's request for changes has had all its items answered;
- no fix round is open;
- GitHub reports the branch rules satisfied (below).

Then the session records the delivery with `record-delivery`. The packet gains an optional `humanReview` object, present only when the selection holds a human, so a bot-only packet and its digest stay unchanged:

```json
{
  "humanReview": {
    "branchRules": {"mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED"},
    "reviewers": [{"login": "alice", "id": 101, "type": "User", "status": "approved", "reviewId": "5470930001", "commitId": "<head>"}],
    "unanswered": [],
    "changesRequested": [{"login": "bob", "id": 202, "selected": false, "answered": true}]
  }
}
```

`branchRules` carries GitHub's own values, read with `gh pr view --json mergeStateStatus,reviewDecision` at the time the packet is built. They are satisfied when `mergeStateStatus` is `CLEAN` or `HAS_HOOKS`, or `UNSTABLE` (a check GitHub does not require failed; the required checks are judged by `requiredChecks` as now), and `reviewDecision` is `APPROVED` or null (the repository requires no review). `UNKNOWN` is read again and never counts. Any other value adds `branch-rules-unmet:<mergeStateStatus>:<reviewDecision>`. Each entry of `unanswered` adds `feedback-unanswered:<item-id>`, and each `changesRequested` entry with `answered: false` adds `changes-requested:<login>`. Reviewer statuses (`approved`, `changes-requested`, `commented`, `pending`, `stale-approval`, `gone`) are recorded and reported; they are not classification reasons of their own, because Concord defines no required-approver list and the branch rules are the merge requirement. A bot LGTM therefore never masks a pending human approval: when the repository requires a human approval, GitHub's review decision is not `APPROVED` and the head is `blocked`.

`merge-ready` takes the same `branchRules` and reports `branch-rules-unmet` from the live values. A reviewer entry of type `User` is not checked for `no-lgtm`; the branch rules and the current delivery record cover it. Bot entries are checked as now. `merge-ready` stays a gate for an agent's merge at the user's explicit request; it never merges by itself.

When the deadline passes first, the run parks. It records no delivery, because collection for the head is not terminal. The handoff says human review is pending and is not approval, names each selected reviewer's status, says whether the branch rules are satisfied right now, lists every unanswered item, and gives the resume command. A parked PR resumes on the next invocation with the same ledger.

## Approval

Only a GitHub Approve review counts as a human approval, and only for the commit it is attached to: the review's own commit must be the live head. The collector's rule that a review belongs to the head when one of its inline comments was made there does not apply to approval, and a review whose commit a force-push dropped (`null`) approves nothing.

A push makes every earlier Approve stale for the new head, whatever the repository's own setting for dismissing stale approvals: the reviewer's status becomes `stale-approval`, the skill sends that reviewer one re-review request for the new head, and the wait goes on. The repository's setting still decides what GitHub's review decision reports, and delivery reads that decision.

A comment-only LGTM from a selected human ("LGTM", "looks good to me", with no condition) is read as an intent to approve, not as approval. The skill replies once, asking the reviewer to press Approve on GitHub because the branch rules require a GitHub approval, and records an `approve-prompt` marker for that reviewer and head so it never asks twice on one head. A conditional or ambiguous comment ("LGTM, but fix X", "LGTM once CI passes", "probably fine") is never read as approval: it is feedback, or it gets a clarifying reply. The same text from an unselected person is ordinary feedback and gets no prompt.

An Approve review with a body is an approval and a feedback item. A blocker in its body is fixed, which pushes and makes the approval stale; a minor is answered and collected, and the approval stands.

A dismissed review approves nothing. A dismissed request for changes no longer counts as an outstanding request for changes, while its unanswered items remain feedback.

## Mixed selections

In a mixed selection the bot loop and the human path share one head, one batch and one fix round. The bot window, grace and request claims run first on each head and apply only to the selected bots; human feedback that arrives during the window waits for the window to end and joins the same batch. This keeps one push per head: a fix for a bot finding never races a human who is midway through reviewing the same head, beyond the 15-minute window.

A bot's LGTM is a bot's signal and ends nothing while a selected human is awaited. A bot's finding blocks as it does now. A human's approval does not clear a bot's unfixed blocker, and a bot's LGTM does not clear a human's unanswered item.

## Ledger

The human path adds these markers beside the bot loop's. Each is written with the existing write-once primitive; those marked as locked are written under the PR transition lock, whose `transition-busy` answer is retried later.

| Marker | Scope | Content |
|---|---|---|
| `pr-<n>.reviewers-<sequence>.json` | PR, locked | The selection: `[{login, id, type}]`, recorded time; the latest sequence wins |
| `pr-<n>-<head>.human-wait-<sequence>.json` | head | `startedAtMs`, `deadlineMs`; the latest sequence wins and keeps the first start |
| `pr-<n>-<head>.human-request-<reviewer>-claim.json`, `-request.json` | head and reviewer | Request claim, then the sent marker |
| `pr-<n>.reply-<item>-claim.json` | PR, locked | Reply claim for one feedback item revision |
| `pr-<n>.feedback-<item>.json` | PR | Handled record: item id and revision, kind, URL, author `{login, id, type}`, original commit, disposition, reason, reply URL, fix commit |
| `pr-<n>-<head>.approve-prompt-<reviewer>.json` | head and reviewer | The single request to press Approve on that head |
| `pr-<n>.wait.json` | PR | Non-authoritative sidecar of the wait: previous head, fingerprint, failure count |

`<reviewer>` and `<item>` are the first 16 hex digits of the SHA-256 of the account id and of the item node id with its revision, the same scheme as the existing provider-keyed request markers. Review records gain the optional fields listed under Observation shape. `status` gains `reviewers` (the selection with each status), `humanWait` (start and deadline of the head) and `unanswered` (item ids without a handled record).

## Failure and edge cases

| Case | Behavior |
|---|---|
| Reviewer renamed | Matched by account id; the next run writes the new login into a new selection record |
| Reviewer deleted | Status `gone`; never awaited; named in the handoff; their feedback keeps its id and URL |
| Login reused by another account | Not matched, because the id differs |
| Selected login is the PR author or an organization | `select-reviewers` refuses it |
| Review dismissed | Approves nothing; a dismissed request for changes stops counting; its items stay feedback |
| Force-push | A new head: approvals stale, one request per selected human, bot collection for the new head; a review whose commit was dropped approves nothing; items made on dropped commits keep their id, URL and the recorded original commit |
| Thread outdated | Still answered once if unanswered; never resolved by the skill; an answered outdated thread wakes nothing |
| Reviewer replies again in a thread | A new item; wakes the wait; answered once |
| Comment edited after the answer | A new revision; answered once more |
| PR closed or merged during the wait | `closed` or `merged`; the run stops and posts nothing |
| Draft PR | The skill requests no human review on a draft and tells the user; the human path starts when the PR is ready |
| Review request refused by GitHub | Reported once; not retried; reviewer still awaited |
| Rate limit | The wait sleeps until GitHub's reset time within its window; not a failure |
| GitHub unreachable | Backoff; ten consecutive failures across windows end the wait with `error` |
| Fix budget exhausted | Stop for human reconciliation as in the bot loop; replies that claim no fix are still posted |
| Two sessions on one PR | Reads are harmless; reply and request claims, fix-round claims and delivery records are write-once or locked, so one session posts and the other gets a claimed or busy answer; a duplicate background wait only costs polls |
| Crash between a post and its marker | Settled from GitHub on resume: the reply's hidden first line, or the timeline's review-request event |
| More than 100 reviews or PR comments | Paged; a connection beyond the page bound fails the collection instead of truncating |

## Security

Review text is untrusted input. The collector size-limits every body and marks it `untrusted`, and the packet only hints: the session re-reads `status` before acting. The verifier and adjudicator receive review text marked as data. Instructions in a comment (to approve, merge, push elsewhere, run a command, change scope, reveal a file) are not followed; a scope change goes to human reconciliation as in the bot loop, and only the user's own explicit request authorizes a merge.

Approval cannot be claimed in text. A comment saying an approval was given, on someone's behalf or otherwise, is feedback. Only an Approve review whose author's account id and type match a selected reviewer and whose commit is the live head counts toward the end condition, so a non-selected account cannot impersonate a selected one by login, by display name, by a `[bot]`-like name, or by quoting them.

Replies are written by the skill from its own verdict. They carry the disposition, the evidence and commit or file references, and do not copy review text beyond the short quote needed to identify the item, so an injected string in a comment is not republished under the author's account. The skill posts only on the PR it runs for.

## Hosts and distribution

The state engine, collector and wait script are shared code; the Codex and Copilot packages carry their bundled copies as they do now, and the bundle-drift tests keep them byte-identical. The skill text is one contract with host-specific wait steps, as in the Wait table, and the skill-content tests compare the three copies. The skill's description names human reviewers as well as automated ones, so a request to address a colleague's review triggers it.

## Rationale

The bot loop already holds the parts a human review needs: a verifier that treats review text as data, a bounded and owned fix round, provenance per review, minors routed to follow-up tickets, and a delivery record. A second loop for humans would duplicate all of it and drift. The human path therefore adds identity, a durable answered-feedback record, a cheap long wait, and a delivery rule, and reuses everything else.

Selecting reviewers per PR, rather than importing GitHub's requested reviewers or reading a repository configuration, keeps the awaited set the user's explicit choice: GitHub's list changes when anyone clicks, and a configuration would make one PR's choice every PR's rule. Typing reviewers by GitHub's account type removes a setting that could disagree with reality.

Collecting feedback by whether it is answered, rather than by the head it was made on, follows from what a human comment is: an open question to the author that a push does not close. Collecting approvals by head follows from what an approval is: a statement about one commit.

Waiting in a script that polls GitHub keeps the model out of a wait that is mostly silence: a model that sleeps or polls pays a request each time, while one model call per two-hour window on Claude Code costs about 13 calls a day. Persisting the deadline in the ledger keeps a resumed session from restarting the clock. A deadline that parks instead of failing keeps a slow reviewer from being reported as a provider failure or, worse, as consent.

Asking a comment-only LGTM to press Approve, instead of reading it as approval, follows the branch rules: a merge needs a GitHub approval, and a comment is not one. Asking once avoids nagging.

Delivering on GitHub's merge state and review decision, rather than on a Concord list of required approvers, keeps one source of truth for merge requirements. The repository's maintainers already state them in branch rules, and a second list in Concord would disagree with them sooner or later.

Rejected alternatives:

- **Treating a human as a bot with a longer window.** The bot window ends in `review-timeout`, a failure; for a human, silence is normal. The bot packet also drops feedback made on older heads, which a human still expects answered.
- **Reading silence after a deadline, a thumbs-up, or green CI as approval.** Each lets the absence of an objection merge code a person never approved.
- **Resolving a human's thread after the fix.** It hides the exchange from the reviewer, who is the one who decides whether the fix answers the comment.
- **Reminding or re-requesting a silent reviewer.** It spends a colleague's attention to save the author a resume; the user can nudge in person.
- **Counting human review requests against the bot request budget.** One request per push is the normal human workflow; the bot budget limits an exceptional manual trigger.
- **Holding the wait in a model session, or with `Monitor`.** The first pays per poll; the second stops after 30 minutes.
- **A separate skill for human reviewers.** It would split one PR's feedback across two loops with two budgets and two delivery records.

## Residual exposure

- Whether an item is actionable, already answered, conditional, or an unconditional LGTM is judged by the model from untrusted text. A misjudged item is visible in the handled record and in the reply, but the script cannot detect it.
- The end condition waits for every selected human's approval of the live head. A reviewer who never presses Approve leaves the PR parked at each deadline until the user changes the selection.
- GitHub computes `mergeStateStatus` for the reading account, and some values are recomputed lazily. A wrong or `UNKNOWN` value delays delivery; it never makes a head mergeable, since only the listed values pass.
- A reply posted while GitHub was unreachable for the marker search may be found only on a later resume; the hidden first line prevents a second post once it is found.
- The wait polls at 60-second intervals, so a response is seen up to a minute late on Claude Code, and on Codex and Copilot only at the next explicit resume.

## Transition table

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| no selection | `select-reviewers` with a human and a bot | selection record with login, id and type each; `status.reviewers` lists both | introduced | `select-reviewers stores login, id and GitHub type for each reviewer` |
| selection stored | resume without `--reviewer` | stored selection used; no record written | introduced | `a resume without --reviewer uses the stored selection` |
| selection stored | run with a different `--reviewer` list | new selection record; latest wins; earlier records kept | introduced | `a run that names reviewers replaces the selection and keeps the earlier record` |
| selection stored | a reviewer renamed on GitHub | new record with the new login; matching by id continues | introduced | `a renamed reviewer is matched by account id and the selection records the new login` |
| any | `select-reviewers` names the PR author or an organization | refused; nothing written | introduced | `select-reviewers refuses the PR author and an organization` |
| user account whose login equals a bot slug | it comments | treated as an unselected human; not the bot | introduced | `a user account named like a bot is not matched to the bot` |
| human-only selection, head H, no feedback | first run | one review request per human; human wait opened with the 48-hour default; no bot window | introduced | `a human-only selection requests each human once and opens a 48-hour wait without a bot window` |
| mixed selection, head H | first run | bot window, grace and claims for the bots only; humans absent from the bot packet's `pending` | changed | `the bot packet lists only selected bots as pending` |
| mixed selection, human silent | 15 minutes pass | no `review-timeout`; the human wait continues | introduced | `a silent human never produces review-timeout` |
| bot-only selection | any event of the bot loop | behavior and records as the bot loop defines them | unchanged | the existing collector and state tests |
| head H, selected human submits a review with inline findings | collect | one observation with each inline item as a finding with item id, kind, author and original commit | introduced | `a selected human's review becomes an observation that keeps identity, URL, commit and items` |
| head H, review body only, `CHANGES_REQUESTED` | collect | the body is one finding; not `completed-without-lgtm` | introduced | `a request for changes with only a body is feedback, not completed-without-lgtm` |
| head H, PR conversation comment by a selected human | collect | observation `comment-<id>` with one finding | introduced | `an actionable PR comment becomes a comment observation` |
| head H2, unanswered inline item made on H1 | collect on H2 | item enters H2's batch with `originalCommitId` H1 | introduced | `feedback made on an older head is collected on the live head with its original commit` |
| head H2, reply by a reviewer in a thread opened on H1 | collect | the reply is an item | introduced | `a reply in an older thread is feedback on the live head` |
| unselected person comments | collect | item enters the batch; assessed and answered like any other | introduced | `feedback from an unselected person enters the batch` |
| unselected person requests changes | answered items | completion blocked until all its items are answered; then not blocking | introduced | `an unselected request for changes blocks until its items are answered` |
| unselected person approves the live head | wait | not counted for any selected reviewer | introduced | `an unselected approval does not stand in for a selected reviewer` |
| item assessed `rejected`, `minor`, `clarify` | reply | one reply with the verdict and reason, posted without a push; thread left unresolved | introduced | `a reply that claims no fix is posted without a push and leaves the thread unresolved` |
| item assessed `blocker` | fix round, push, checks pass | one reply naming the fix commit; thread left unresolved | introduced | `a fixed item's reply names the fix commit and the thread stays unresolved` |
| reply claimed, post accepted, crash before `record-reply` | resume | reply found by its hidden first line; handled record written; no second post | introduced | `an interrupted reply is found by its marker and not posted twice` |
| reply claimed, post never reached GitHub | resume | posted once | introduced | `a reply claim with no post on GitHub posts once on resume` |
| two sessions, same item | both claim | one posts; the other gets `reply-claimed` | introduced | `two sessions answer one item once` |
| answered item | the reviewer edits it | answered once more | introduced | `an edited item is answered again once` |
| push to H2 | after push | one request per selected human; bot request budget unchanged | introduced | `each push sends one request per selected human and spends no bot request` |
| request claimed, crash before the sent marker | resume | timeline event found: marked sent; else sent once | introduced | `an interrupted review request is settled from the timeline` |
| GitHub refuses a request | request | `request-refused:<login>` reported once; reviewer still awaited | introduced | `a refused review request is reported once and not retried` |
| head pushed by someone else | wait | `head-moved`; collection for the new head; one request per selected human | introduced | `a push by another account makes approvals stale and requests re-review once` |
| waiting on H, deadline not passed | window of 6600 seconds ends | `idle`; same command run again; nothing posted | introduced | `wait-feedback --max-wait ends a silent window with idle` |
| waiting | a reaction, a label or a CI change | no wake | introduced | `reactions, labels and CI changes do not wake the wait` |
| waiting | new item from anyone | `feedback` | introduced | `a new item wakes the wait with feedback` |
| waiting | selected human approves H | `approved` | introduced | `a selected approval on the live head wakes the wait` |
| waiting on H, session replaced | resume | same deadline; clock not restarted | introduced | `a resumed wait keeps the persisted deadline` |
| waiting on H | `--human-wait 24` on resume | deadline moved from the original start; later heads use 24 hours | introduced | `--human-wait moves the current deadline from the original start` |
| waiting on H | deadline passes | `deadline`; park; no delivery; handoff says human review pending and not approval | introduced | `the deadline parks the run without a delivery and reports human review pending` |
| waiting | GitHub fails ten polls across windows | `error` | introduced | `ten failed polls across windows end the wait with error` |
| waiting | rate-limit response | sleeps until reset within the window; failure count unchanged | introduced | `a rate-limit response is not counted as a failure` |
| selected human approved H1 | push to H2 | `stale-approval`; not counted; one request | introduced | `an approval of an earlier head is stale for the new head` |
| Approve review whose commit was dropped by a force-push | collect | approves nothing | introduced | `a review whose commit is gone approves nothing` |
| Approve review on H dismissed | collect | approves nothing | introduced | `a dismissed approval approves nothing` |
| selected human comments "LGTM" with no condition | assess | one reply asking to press Approve; `approve-prompt` marker; not approval | introduced | `a comment-only LGTM gets one request to press Approve and is not approval` |
| `approve-prompt` exists for H | the same reviewer comments "LGTM" again | no second prompt | introduced | `the Approve prompt is sent once per reviewer and head` |
| selected human comments "LGTM, but fix X" | assess | feedback; never approval | introduced | `a conditional LGTM is feedback` |
| generic thumbs-up from a selected human | any | never LGTM; no wake | introduced | `a reaction is never human approval` |
| mixed, bot LGTM, human pending | end condition | not met; wait continues | introduced | `a bot LGTM does not end the wait while a human is awaited` |
| all selected approved H, nothing unanswered, rules satisfied | deliver | delivery recorded with `humanReview`; `mergeable-*` | introduced | `delivery with all approvals and satisfied branch rules is mergeable` |
| all selected approved H, `reviewDecision` `REVIEW_REQUIRED` | deliver | `blocked`, `branch-rules-unmet:BLOCKED:REVIEW_REQUIRED` | introduced | `branch rules unmet block delivery although every selected reviewer approved` |
| bot-only packet | `record-delivery` | no `humanReview`; same digest and classification as the bot loop | unchanged | `a bot-only delivery packet keeps its digest` |
| `merge-ready`, human entry, rules unmet | gate | `branch-rules-unmet`; no `no-lgtm` for the human entry | changed | `merge-ready reports branch rules for human reviewers` |
| fix budget exhausted, human item is a blocker | assess | stop for human reconciliation; non-fix replies still posted | unchanged | `human feedback spends the shared fix-round budget` |
| PR merged or closed during the wait | poll | `merged` or `closed`; nothing posted | introduced | `a merged or closed PR ends the wait` |
| reviewer account deleted | resume | `gone`; not awaited; named in the handoff | introduced | `a deleted reviewer is gone and not awaited` |
| first run, item already answered by the author | assess | handled as `already-answered` with the link; nothing posted; listed in the handoff | introduced | `an item the author already answered is recorded and not answered again` |
| PR with more than 100 comments | collect | all pages read; beyond the bound the collection fails | changed | `PR comments and reviews past the first page are collected` |

A selected bot never receives a human review request, and a human never enters the bot request budget; both follow from the reviewer's stored type, so no row combines them.

## Acceptance criteria and fixtures

Each criterion of the extension maps to collector fixtures (GraphQL responses in the shape of the existing `fixtures/review-collector` file), state-engine cases, and skill-content assertions:

| Criterion | Fixture cases (transition-table evidence) |
|---|---|
| Explicit selection of humans, bots or a mixed set, keeping identity and links | `select-reviewers stores login, id and GitHub type for each reviewer`; `a selected human's review becomes an observation that keeps identity, URL, commit and items`; `a renamed reviewer is matched by account id ...`; `a user account named like a bot is not matched to the bot` |
| A selected human's review, inline finding, reply or actionable PR comment enters the workflow; an unrelated person's comment is not that reviewer's approval | `a request for changes with only a body is feedback ...`; `an actionable PR comment becomes a comment observation`; `a reply in an older thread is feedback on the live head`; `an unselected approval does not stand in for a selected reviewer`; `feedback from an unselected person enters the batch` |
| Evidence-backed replies, with the fix commit when applicable; rejected and deferred feedback keeps reason and provenance; threads stay unresolved | `a fixed item's reply names the fix commit and the thread stays unresolved`; `a reply that claims no fix is posted without a push ...`; `an interrupted reply is found by its marker and not posted twice` |
| After a push, human re-review is pending and resumes without losing findings, duplicating replies or requests, or resetting budgets | `each push sends one request per selected human and spends no bot request`; `an interrupted review request is settled from the timeline`; `a resumed wait keeps the persisted deadline`; `feedback made on an older head is collected on the live head ...`; `human feedback spends the shared fix-round budget` |
| A delayed human response follows the waiting policy, is not a provider failure or approval; silence and reactions never yield LGTM | `a silent human never produces review-timeout`; `wait-feedback --max-wait ends a silent window with idle`; `the deadline parks the run without a delivery ...`; `a reaction is never human approval`; `a comment-only LGTM gets one request to press Approve ...` |
| A human approval belongs to its commit; a later push cannot reuse it; requests for changes stay visible | `an approval of an earlier head is stale for the new head`; `a review whose commit is gone approves nothing`; `a dismissed approval approves nothing`; `an unselected request for changes blocks until its items are answered` |
| In a mixed set, a bot LGTM cannot mask a pending human review or an unresolved blocker; delivery reports each reviewer's status | `a bot LGTM does not end the wait while a human is awaited`; `branch rules unmet block delivery although every selected reviewer approved`; `delivery with all approvals and satisfied branch rules is mergeable` (asserting `humanReview.reviewers`) |
| Bot-only collection, reconciliation, ownership, budget and delivery behavior stays covered | the existing collector and state tests unchanged; `the bot packet lists only selected bots as pending`; `a bot-only delivery packet keeps its digest` |

The fixture set covers human-only and mixed selections, delayed feedback (a review arriving after several idle windows), repeated feedback (a second reply in one thread, an edited comment), comment replies, stale approvals, head changes (the skill's push, another account's push, a force-push that drops the reviewed commit), and interruption and resume (a crash after a reply post, after a request, and a session replaced mid-wait). The skill-content tests assert the wait commands per host, the absence of `Monitor` for the human wait, the never-resolve rule for human threads, the single Approve prompt, and that the Codex and Copilot copies match the shared skill.
