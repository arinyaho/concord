# review-until-lgtm with human reviewers

`review-until-lgtm` runs on the PR author's side: it collects the review feedback a pull request receives, verifies it, fixes what blocks the rollout, replies, and repeats on the new head until the PR can be delivered. The bot-only loop is described in the [review-until-lgtm design](review-until-lgtm.md). This note extends the same loop to human reviewers, alone or mixed with automated ones, so a colleague's review goes through the same verification, bounded fixing, provenance and delivery rules as a bot's.

A human reviewer differs from a bot in three ways that the bot loop cannot absorb by configuration alone. A human answers in hours or days, not within a 15-minute window, so silence is normal and is not a provider failure. A human talks back: replies in threads, PR conversation comments and questions are feedback, not noise. A human's approval is a GitHub Approve review that the repository's branch rules count, and it belongs to one commit. The design keeps the bot loop and its state engine and adds what these three differences require: a reviewer identity with a type, a feedback record that survives pushes, a wait that costs no model tokens, and a delivery rule that defers to the branch rules.

The PR's ledger in this note is the set of marker files the state engine (`core/lgtm-state.js`, exposed as `review-lgtm-state`) keeps in the repository's git directory, keyed by PR number and, where a marker belongs to one head, by the exact head SHA.

## Goals

- The user selects the human reviewers of one PR explicitly, and may name bots in the same list; a resumed session reads the selection from the ledger.
- Every piece of human feedback on the PR, from a selected reviewer or any other person, is verified and answered once: fixed with the fix commit named, rebutted with evidence, or answered with a clarifying question; an item that asks nothing of the author (a status notice) or that the author already answered is recorded as handled and posts nothing.
- After an authorized push, each selected human reviewer is asked to review the new head once, and the session waits without model calls until the branch rules are satisfied, new feedback arrives, or the wait deadline passes.
- Only a GitHub Approve review on the current head counts as a human approval, and delivery follows what GitHub reports about the branch rules.
- With no reviewer named, the skill observes every review and comment on the PR, from any account, and completion is decided by answered feedback and the branch rules alone.
- A named bot keeps the bot loop's collection window, automatic-review grace, request claims, request and fix budgets, fix ownership and delivery behavior.

## Non-goals

- Merging. An agent merges only through the existing merge gate at the user's explicit request.
- Reviewing someone else's PR. That is `review-until-approve`, which acts as the reviewer; this skill acts as the author.
- Choosing reviewers from GitHub's requested-reviewer list, CODEOWNERS, or a repository configuration. Awaited reviewers, human or bot, come only from the user (see Selection).
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

Reviewers come only from the selection. GitHub's requested reviewers, the repository's configuration and any built-in default reviewer are not read: a person or bot a teammate requested in the GitHub interface is not awaited and receives no request from the skill, while their feedback is still accepted (see Feedback). The bot list is exactly the bots the selection names.

### Empty selection

With no `--reviewer` and no stored selection, the selection is empty and the skill observes everything:

- **Collected.** Every review, inline comment and PR conversation comment on the PR from any account, human or bot, other than the PR author and the acting account, by the unanswered test under Feedback items.
- **Awaited.** Nobody. No account's response or LGTM is waited for, no review request of any kind is sent, and completion is decided by the end condition alone: every item answered, no fix round open, the head's collection settled, and the branch rules satisfied.
- **Collection on a head.** The bot loop's 15-minute window opens when the session first observes the head, not at the first activity, so automatic reviews that bots run on every push land in one batch; the head's collection is settled when that window ends. The automatic-review grace and the request claims do not apply, because they exist to avoid racing and to bound a manual request to a named provider, and no request is sent. The bot request budget is not spent. Activity after the window is handled by the wait as feedback.
- **Bot signals.** A bot's LGTM or clean result is recorded but ends nothing, because nobody is awaited. A bot's findings are assessed as any feedback; a bot's minor follows the bot rule (collected and ticketed) and a round with only bot items spends the bot fix cap.
- **Resume.** A resume with no `--reviewer` keeps the empty selection and observes everything again by the same unanswered test, so nothing is answered twice. A resume that names reviewers writes a selection record and switches to the named semantics; a later resume without `--reviewer` keeps that stored selection. Returning to observing everything takes `select-reviewers <pr> --none`, which writes an empty selection record.

Status, preview and coverage bots post PR conversation comments that ask nothing of the author. In empty mode they are items like any other, handled by a design choice that keeps them cheap: a bot's conversation comment is assessed once, normally as `no-action`, which records it as handled with its reason, posts no reply and claims no fix round; an edit of a bot's conversation comment is not a new revision, so a bot that updates its comment in place wakes the wait only once. A bot's review and inline comments get no such exemption, because a bot's code review can raise a real finding.

### Named selection

A named selection defines whose response is awaited and who receives a re-review request after a push; people outside the list are still collected and answered as feedback. A bot outside a named list is not collected: its reviews, inline comments and conversation comments are ignored and wake nothing. This holds also for a list that names only humans, which therefore has an empty bot list and no bot window; that is a design choice, made so that naming reviewers narrows the bots to the ones the user asked for, while the empty selection is the way to hear from every bot.

### Type

A reviewer is a human or a bot by GitHub's account type (`type` of the user API, `User` or `Bot`), never by configuration or by a `[bot]` suffix in what the user typed. `select-reviewers` tries the login as given and, when GitHub has no such user, the login with `[bot]` appended, because GitHub names an app's account `<slug>[bot]`. It refuses an `Organization`, an account GitHub cannot resolve, and the PR author's own account, because GitHub does not let an author review their own PR.

Each observed review, comment and reply is matched to a selected reviewer by account id and type (`author { __typename ... on User { databaseId } ... on Bot { databaseId } }` in the collector's query), never by login alone. The collector's login normalization strips a `[bot]` suffix, so by login alone a user account whose login equals a bot's slug would be read as that bot; matching on id and type closes that.

### Identity across renames and deletions

The account id is the identity; the login is a display name. At every `select-reviewers` and at the start of every resumed run, the skill resolves each stored id to its current login and, when the login changed, writes a new selection record with the new login, so a login freed by a rename and taken by another account never becomes that reviewer. An id GitHub no longer resolves is a deleted account: its status is `gone`, it receives no request, and the handoff names it so the user can change the selection. Feedback it left stays in the record under its id and URL.

### What the selection decides

The selection decides whose response is awaited, who receives a re-review request after a push, and whose status the handoff reports. It does not decide who may give feedback, and it does not decide what counts as merge-ready: the branch rules do (see Deliver).

## Feedback

### What counts

Feedback is any of these on the PR, written by an account other than the PR author and the account the skill acts as:

- a submitted review's body, when it is not empty;
- an inline review comment, including a reply in an existing thread;
- a PR conversation comment.

A person's feedback is accepted whether or not that person is selected. A bot's feedback is accepted from every bot in empty mode and only from the named bots under a named selection (see Selection).

A review's state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`) is a signal, separate from its text. Reactions are neither feedback nor signal for a human; the Codex thumbs-up path stays a bot adapter. A comment in a resolved thread is not feedback, as in the bot loop.

A review, inline comment or actionable PR comment from a person who is not selected enters the same assess, fix and reply flow. An approval from an unselected person never stands in for a selected reviewer's response; it counts only as far as the branch rules count it. A request for changes from an unselected person holds Concord's fix and reply work until the author has answered every item of that person's review; after that Concord counts it as addressed and sends that person no re-review request. GitHub keeps its review decision unmet until that person re-reviews or the review is dismissed, so in a repository whose rules require reviews the branch rules stay unmet and delivery reports `feedback answered, waiting for <login> to re-review or dismiss` as a pending branch-rule condition, never as approval. The run waits to the per-head deadline and then parks like any other human wait; Concord never dismisses a review. In a repository whose rules require no review the same state is merge-ready, as the branch rules say.

### Feedback items and the unanswered set

A feedback item is identified by its GitHub node id and its revision (`lastEditedAt`, or the creation time when never edited). An item edited after it was answered is a new revision and is answered again once.

An item is unanswered unless one of these holds, and the collector and the wait apply exactly the same test:

- `pr-<n>.feedback-<item>.json` exists: the handled record written after the skill's reply, or the record of an author answer or a no-reply disposition;
- `pr-<n>.reply-<item>-claim.json` exists: a session has claimed the reply;
- the item id is listed in the `itemIds` of a `pr-<n>-<head>.fix-round-claim.json` of any head of the PR: a fix round has taken it;
- the PR author or the acting account has answered it on GitHub (below).

The fix-round test is what keeps a fixed item out of the next head's batch: the item's fix is pushed in the round that claimed it, the new head's collection finds the item in that claim, and no second fix round is spent on it. A claimed item whose round finished without a handled record is listed by `status` as `owedReplies`, and the session posts those replies before collecting again.

### Author answers

The author's own answers count on every collection, not only on the first run, so an author who answers a colleague by hand while the skill waits gets no second answer from the skill. An answer is recognized from GitHub data alone:

- for an inline item, a later comment in the same review thread by the PR author or the acting account;
- for a review body or a PR conversation comment, a later PR conversation comment or review body by the PR author or the acting account that contains the item's URL, which is what GitHub's "Quote reply" and "Copy link" produce.

When the collector recognizes an answer, the skill writes the item's handled record with disposition `author-answered` and the answer's URL, and posts nothing. An author comment that answers without a link or thread position is not recognized automatically; the assessment may still record it as `author-answered` with that comment's URL. A reviewer's later reply in the thread is a new item.

### Feedback across pushes

A human's comment is made on one commit and is still owed an answer after the head moves. Feedback is therefore collected by whether it is answered, not by the head it was made on: every unanswered item enters the batch of the live head, wherever it was made, and keeps the commit it was made on. This is the deliberate difference from the bot loop under a named selection, which keeps only reviews made on the head and treats older ones as history; in empty mode, bot items follow the same unanswered test. An approval is the opposite: it is attached to one commit and never moves (see Approval).

### Observation shape

The collector already turns each review into one `record-review` observation that keeps the reviewer, the review URL, the commit identity and the findings. The table shows what each field holds and what the human path adds. Every added field is optional, so a bot observation keeps its present shape and bot-only records and packets do not change.

| Field | Held by the bot path | Added for the human path |
|---|---|---|
| `reviewId` | GitHub review database id, decimal digits; the file key `review-<id>` | A thread reply belongs to the review GitHub created for it and joins that review's observation; a PR conversation comment is its own observation with id `comment-<databaseId>` and file key `comment-<databaseId>`, so the two id spaces cannot collide |
| `reviewer` | Login without `[bot]`; required; `legacy/unknown` in status when a record lacks it | `reviewerId` (account id) and `reviewerType` (`User` or `Bot`) beside it |
| `reviewUrl` | Review URL | A comment observation carries the comment URL |
| `commitId` | Must equal the live head; the collector sets it to the head | Unchanged: the head at which the item is handled |
| `reviewCommitId` | In the packet only, not persisted | Persisted, so provenance survives a push; `null` when a force-push dropped the commit |
| `submittedAt` | In the packet only | Persisted |
| `lgtm` | `APPROVED`, or the bot's fresh reaction | For a `User`, true only for an `APPROVED` review whose own commit is the live head |
| `findings[]` | `{url, priority, signals}` persisted; the body and location only in the packet | Each finding also persists `itemId` (node id and revision), `kind` (`review-body`, `inline`, `reply`, `comment`), `author` `{login, id, type}` and `originalCommitId`; the body stays out of the ledger |

Every unanswered human item becomes one finding of its observation, with `priority: null` unless it carries the bot priority markup, so the existing verifier, adjudication, `reject-review-batch` and fix-round machinery handle it without a parallel path. A clean `APPROVED` review with no text produces an observation with no findings and `lgtm` set, which `record-review` does not persist, as for bots; approvals are read from GitHub every time, because GitHub holds the review state and the ledger holds only what GitHub cannot.

The reconciliation packet classifies a head as `requires-architecture-review` when any finding is P1, when any signal is tagged, or when two or more review records are active (`records.length >= 2` in `reconciliationPacket`). Grouping human items per review and per conversation comment keeps provenance per source, but a human discussion easily produces several records on one head. `lgtm-state.js` therefore changes that rule, not only the record fields: the record count becomes the number of active bot records plus one when any human record is active, so the human feedback of a head counts as one batch. P1 and signal triggers are unchanged, and a bot-only head is classified exactly as now.

The collector's top-level reviews and PR comments are read as the newest 100 of each. The human path pages both connections with the same page bound as review threads, failing the collection instead of truncating it, because a human discussion can exceed 100 comments and a silently dropped one would never be answered.

## Lifecycle

One run moves a PR through the steps below on each head. A named list of bots only runs the bot loop exactly as it is; the steps below add the human and empty-selection parts and say where they meet it.

```
select ──► collect (bots: 15-min window; humans: unanswered items)
              │
              ▼
           assess ──► fix round? ──yes──► fix, test, one push ──► request re-review (humans, once per head, not on a draft)
              │                                                        │
              no                                                       ▼
              │                                              collect on the new head
              ▼
     reply to items owed ──► end condition met? ──yes──► deliver
                                   │
                                   no
                                   ▼
                         wait (no model tokens) ──► feedback / rules changed / head moved / ready ──► collect
                                   │
                                   deadline ──► park (resumable, not approval)
```

### Collect

Under a named selection with bots, the bot collection runs first on each head, for the named bots only: `watch` and `collect` receive one `--reviewer` per named bot, the 15-minute window, the 120-second automatic-review grace and the per-provider request claims apply to them as they do now, and the window ends with a `packet` or a `deadline` line as now. A selected human never appears in the bot packet's `pending` list, so a silent human never turns into `review-timeout`. Under a named selection without bots there is no bot window.

In empty mode, `watch` and `collect` receive no `--reviewer` and observe every account. The collector has no built-in fallback reviewer: an empty list means every account, never a default bot. The watch opens the 15-minute window when it first observes the head and prints the head's `packet` when the window ends, with no `pending` list, since nobody is awaited.

When the bot packet is terminal, at once under a named selection without bots, or at the end of the empty-mode window, `collect <pr> <head-sha>` reads every unanswered human item on the PR (by the test under Feedback items) and every selected human's latest review signal, and prints them as observations of the same packet. Items the author already answered are reported in the packet as `authorAnswered` with the answer's URL, and the session writes their handled records instead of recording them for review. The session records every other observation with `record-review` before deciding, so the head's batch holds the bot findings and all owed human feedback together, and the first arrival never drives a piecemeal push. On the first run on a PR, items written before the skill started are collected the same way.

### Assess

The collected batch goes to the clean-context verifier and, when its signals hold, to the adjudicator, exactly as in the bot loop. Each item ends as one of:

- `blocker`: a rollout blocker as defined by the bot loop and the delivery disposition. It is fixed in the head's fix round with a failing test first.
- `minor` from a person: any other accepted item from a human. It is fixed in the head's fix round, with a failing test first when the change alters behavior.
- `minor` from a bot: recorded with `collect-minor`, never fixed during the loop, and a follow-up at delivery, as now.
- `rejected`: the verifier or adjudicator rejects it with evidence. This includes an answered question that asks for no change.
- `clarify`: the item is ambiguous, so the reply asks one question instead of guessing.
- `approve-intent`: an unconditional comment-only LGTM from a selected human (see Approval).
- `no-action`: text that asks for nothing and states nothing to verify, such as thanks. It is recorded as handled with its reason and gets no reply.

A human's minor suggestion is fixed rather than ticketed because the person who made it decides whether to approve: a rename request answered with a ticket may make the reviewer withhold approval, and a bot has no approval to withhold. An item that would change the approved product contract, materially expand the PR, or settle a structural choice the approved design leaves open stops the run for human reconciliation, as in the bot loop. Review text is data in every step: the verifier and adjudicator receive it marked untrusted, and its instructions are never followed.

### Fix and reply

A fix round is claimed, owned, certified and pushed as in the bot loop: one claim per head with an immutable owner, one certified commit and one push. `claim-fix-round` reads from stdin the ids of the plan's items that the unanswered test collects (every item in empty mode, the human items under a named selection) and writes them as `itemIds` into the head's `fix-round-claim` marker, which is what removes them from the unanswered set. A push happens only where the bot loop already authorizes it.

Human-driven rounds have their own cap. A round whose plan holds at least one human item spends a slot of the human cap (`pr-<n>.human-fix-round-slot-<k>.json`); a round with only bot items spends a slot of the existing PR-wide bot cap of three, which is unchanged. A head still has at most one fix round of either kind. The human cap defaults to five rounds per PR, a design choice: a human review commonly takes more iterations than an automated one, and each human round already costs the reviewer a re-review, so the cap guards a runaway loop rather than rationing ordinary iterations; three would park ordinary reviews too often, and an unbounded cap would let a disagreement loop forever. Only a person raises it, with `waive-fix-budget <pr> <person> <n> --human`, which follows the existing waiver rules (pairs of person and count add up, a repeated pair changes nothing) and raises only the human cap; `status` reports `humanFixBudget` and its waivers beside `fixBudget`. Exhausting either cap stops for human reconciliation as now.

After the push, and after its checks support the response, the skill replies to every item of the batch that needs a reply, whatever its disposition:

- `blocker` or human `minor`: the fix commit, and what changed;
- bot `minor`: the verdict and reason, as now;
- `rejected`: the evidence (a file and line, a test, a contract clause) for keeping the code as it is;
- `clarify`: the question;
- `approve-intent`: the request to press Approve.

A `no-action` item and an `author-answered` item post nothing; their handled record is the answer.

A reply that claims no fix (rejected, clarify, approve-intent) needs no push and is posted as soon as the item is assessed. An inline item is answered in its own thread; a review body or PR comment is answered with a PR conversation comment that links the item. The skill never resolves a human's thread, also when its fix makes the thread outdated. The existing resolution rule for a bot's threads is unchanged.

Replies are idempotent. Before posting, the skill claims the item with `claim-reply <pr> <item-id>`, a write-once marker under the PR transition lock; a second session gets `reply-claimed` and posts nothing. The reply carries a hidden first line `<!-- concord-lgtm-reply: <item-id> -->`. After GitHub accepts it, `record-reply <pr> <item-id>` writes the handled record: the item id and revision, kind, URL, author `{login, id, type}`, original commit, disposition, reason, reply URL and fix commit when there is one. A claim without a handled record means an interrupted post: on resume the skill searches the item's thread, or the PR conversation, for a comment by the acting account carrying that first line, records it when found, and posts once when not.

### Request re-review

After each push the skill asks each selected human to review the new head, once per reviewer per head, through GitHub's requested-reviewers API. `claim-human-request <pr> <head-sha> <reviewer-id>` writes a write-once claim; after GitHub accepts the request, `mark-human-requested` writes the sent marker. A claim without a sent marker is settled from the PR timeline: a review-request event for that reviewer by the acting account after the head appeared counts as sent; otherwise the request is sent once. On the first run, a selected human who is not already requested and has not reviewed the head gets the same single request. A request refused by GitHub (the account cannot be requested on this repository) is recorded in the `-refused.json` marker, reported once as `request-refused:<login>`, and not retried: the marker is read before any request.

On a draft PR no review request is sent; everything else runs, including the bot loop and the answering of human feedback. When the wait sees the PR leave draft (`ready`), the skill sends the requests owed for the live head, once each.

Human requests do not spend the bot request budget of three per PR. They are bounded by one request per selected human per head, and they are separate because a re-review request to a person is the normal step after every push, while a manual bot request is the exception the bot budget exists to limit. Bot requests keep their budget, grace and claims unchanged. A head pushed by someone other than the skill also gets one request per selected human, because a push makes every earlier approval stale whoever pushed it. A bot needs no re-review request after a push: the bot loop's automatic-review grace and claims cover it on every head.

### Wait

When the head's batch is assessed, every item is answered or claimed, no fix round is open, and the end condition (see Deliver) is not met, the session waits.

The wait is `wait-feedback <pr> [--max-wait <seconds>] [--once]`, a script in the pattern of `review-until-approve`'s `watch.js`. It reads the ledger without writing ledger markers; its only write is the non-authoritative `pr-<n>.wait.json` sidecar. It polls GitHub every 60 seconds with a small query (head, PR state and draft flag, newest review, comment and reply ids with their edit times, review decision and merge state) and runs the full collection only when that fingerprint changes. It costs no model tokens between polls, prints exactly one JSON line and exits:

| Event | Fires when |
|---|---|
| `feedback` | An unanswered item exists, by the same test the collector uses. A review counts only when its body or inline comments make it an item; a review with an empty body, such as a bare Approve, is not an item, and an approval wakes the wait through `rules-changed` when it changes GitHub's review decision |
| `rules-changed` | GitHub's review decision or merge state changed |
| `head-moved` | The live head differs from the head the ledger last handled, and is the same on two consecutive polls |
| `ready` | The PR left draft |
| `merged`, `closed` | The PR reached that state |
| `deadline` | The head's human-wait deadline passed |
| `idle` | Only with `--max-wait`: the window ended without an event |
| `error` | Ten consecutive failed polls, counted across windows |

Reactions, CI changes that do not change the merge state, labels, comments by bots outside a named list, edits of a bot's conversation comment, and a reviewer's silence wake nothing. Unanswered is decided by the ledger's markers and GitHub's thread order, not by timestamps, because a commit's date is set by whoever made it and the local clock is not GitHub's; in the normal case this is exactly the feedback newer than the last push.

The wait deadline is a design choice made per head. `open-human-wait <pr> <head-sha> <seconds>` writes it when the session first waits on a head, as a write-once record of start and deadline. A resume while the deadline is in the future never restarts the clock. A resume of a PR already parked at its passed deadline opens a new wait for the same head, with a new start, instead of parking again at once: the explicit invocation is the user asking to wait again, and parking immediately would make a parked PR impossible to resume. When the session waits on a head, each re-review request starts a fresh wait on that head, because the request asks the reviewer for a fresh response. The default is 48 hours, a day of margin on a team norm of answering within one day. `--human-wait <hours>` changes it for the run: the skill writes a new record for the current head that keeps the current start and moves the deadline, and later heads use the new length.

Polls back off on failure (doubling the interval up to eight times) and a rate-limit response sleeps until the reset time GitHub reports, bounded by the window end, without counting as a failure. The failure count, the head seen on the previous poll and the last fingerprint live in a non-authoritative sidecar `pr-<n>.wait.json`, so they carry across windows; an unreadable sidecar is treated as empty and at worst repeats one full collection.

How a host runs the wait:

| Host | How the session waits | Model cost |
|---|---|---|
| Claude Code | `wait-feedback <pr> --max-wait 6600` as a Bash `run_in_background` command with `timeout: 7200000`, which wakes the session when it exits; on `idle`, or a run killed by the host with no JSON line, the session runs the identical command again and says nothing | one small model call per window, about 13 a day; a 48-hour wait is about 26 windows |
| Codex, Copilot | No background process can wake the conversation, so the session tells the user the PR is parked and gives the exact resume command. A later explicit resume runs `wait-feedback <pr> --once`, which polls once and prints an event or `idle`; on `idle` before the deadline the session returns the same resume command | one model call per explicit resume |

`Monitor` is not used for the human wait: it stops after 30 minutes, which suits the 15-minute bot window but not a wait of days. The 600 seconds between `--max-wait` and the host timeout leave room for a poll, GitHub latency and startup, so `idle` is printed before the host kills the command. The session builds the command once with absolute paths and never edits, wraps or replaces the script, and never writes its own polling loop. A user stop ends the background task and posts nothing.

While waiting, the skill posts nothing: no mention, no repeated request, no reminder at the one-day mark.

### Resume

Every invocation on a PR with a ledger is a resume. It re-reads the selection and resolves each id's current login, re-reads the live head, and runs `status`. Owed replies of a finished fix round are posted first. A head that differs from the last handled head starts that head's bot collection and human collection. An unchanged head goes straight to the human collection, then to the wait with the persisted deadline, or a new wait when that deadline has passed. Claims without their sent or handled markers are settled from GitHub as described above, so a resume duplicates no reply and no request. The request and fix budgets of both kinds, waivers and collected minors are PR-wide and survive any number of resumes and session replacements, as they do now.

### Deliver

The end condition holds when, for the live head:

- the head's collection is settled: the named bots' collection is terminal as the bot loop defines it, or in empty mode the head's 15-minute window has ended;
- every human item is answered, which covers every unselected person's request for changes;
- no fix round is open;
- GitHub reports the branch rules satisfied (below).

Branch rules alone decide merge-readiness; Concord requires no selected reviewer's approval. In a repository whose rules ask for nothing (a null review decision and a `CLEAN` merge state), the head is merge-ready as soon as the other three conditions hold, also when a selected reviewer has not responded. Then the session records the delivery with `record-delivery`. The packet gains an optional `humanReview` object, present only when the PR has a selected human or human feedback, so a bot-only packet and its digest stay unchanged:

```json
{
  "humanReview": {
    "branchRules": {"mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED"},
    "reviewers": [{"login": "alice", "id": 101, "type": "User", "status": "approved", "reviewId": "5470930001", "commitId": "<head>"}],
    "unanswered": [],
    "changesRequested": []
  }
}
```

`branchRules` carries GitHub's own values, read with `gh pr view --json mergeStateStatus,reviewDecision` at the time the packet is built. They are satisfied when `mergeStateStatus` is `CLEAN` or `HAS_HOOKS`, or `UNSTABLE` (a check GitHub does not require failed; the required checks are judged by `requiredChecks` as now), and `reviewDecision` is `APPROVED` or null (the repository requires no review). `UNKNOWN` is read again and never counts. Any other value adds `branch-rules-unmet:<mergeStateStatus>:<reviewDecision>`. Each entry of `unanswered` adds `feedback-unanswered:<item-id>`, and each `changesRequested` entry with `answered: false` adds `changes-requested:<login>`. Reviewer statuses (`approved`, `changes-requested`, `commented`, `pending`, `stale-approval`, `gone`) are recorded and reported; they are not classification reasons. A bot LGTM never masks a pending human approval: when the repository requires a human approval, GitHub's review decision is not `APPROVED`, the end condition does not hold, and the session keeps waiting.

`merge-ready` takes the same `branchRules` and reports `branch-rules-unmet` from the live values. A reviewer entry of type `User` is exempt from `no-lgtm`, `reviewer-pending`, `reviewer-missing` and `no-automated-review`, so a humans-only named selection whose human is silent (recorded `pending`) leaves an unprotected head merge-ready; the branch rules and the current delivery record cover it. Named bot entries are checked as now. In empty mode `expectedReviewers` is empty and observed bots are passed without a `no-lgtm` check, because nobody is awaited; `no-automated-review` is not reported, because nobody is awaited: an unreviewed head whose branch rules are satisfied is merge-ready, as its delivery record says. `merge-ready` stays a gate for an agent's merge at the user's explicit request; it never merges by itself.

When the deadline passes first, the run parks. It records no delivery, because the end condition does not hold. The handoff says human review is pending and is not approval, names each selected reviewer's status, says which branch-rule values are unmet (naming `feedback answered, waiting for <login> to re-review or dismiss` for each answered request for changes that keeps the review decision unmet), lists every unanswered item, says for a draft PR that no review request was sent and that the requests go out when it is marked ready, and gives the resume command. A parked PR resumes on the next invocation with the same ledger and a new wait.

## Approval

Only a GitHub Approve review counts as a human approval, and only for the commit it is attached to: the review's own commit must be the live head. The collector's rule that a review belongs to the head when one of its inline comments was made there does not apply to approval, and a review whose commit a force-push dropped (`null`) approves nothing. The reviewer's status follows from this; the branch rules, through GitHub's review decision, decide whether approvals suffice.

A push makes every earlier Approve stale for the new head, whatever the repository's own setting for dismissing stale approvals: the reviewer's status becomes `stale-approval` and the skill sends that reviewer one re-review request for the new head. The repository's setting still decides what GitHub's review decision reports, and delivery reads that decision.

A comment-only LGTM from a selected human ("LGTM", "looks good to me", with no condition) is read as an intent to approve, not as approval. The skill replies once, asking the reviewer to press Approve on GitHub because the branch rules count a GitHub approval and not a comment, and records an `approve-prompt` marker for that reviewer and head so it never asks twice on one head. A conditional or ambiguous comment ("LGTM, but fix X", "LGTM once CI passes", "probably fine") is never read as approval: it is feedback, or it gets a clarifying reply. The same text from an unselected person is ordinary feedback and gets no prompt.

An Approve review with a body is an approval and a feedback item. Fixing what its body asks pushes and makes the approval stale, and the reviewer gets one re-review request.

A dismissed review approves nothing. A dismissed request for changes no longer counts as an outstanding request for changes, while its unanswered items remain feedback.

## Mixed selections

In a mixed selection the bot loop and the human path share one head, one batch and one fix round. The bot window, grace and request claims run first on each head and apply only to the bots; human feedback that arrives during the window waits for the window to end and joins the same batch. This keeps one push per head: a fix for a bot finding never races a human who is midway through reviewing the same head, beyond the 15-minute window. The round spends the human cap when its plan holds a human item and the bot cap otherwise.

A bot's LGTM is a bot's signal and does not satisfy branch rules that require a human approval. A bot's finding blocks as it does now. A human's approval does not clear a bot's unfixed blocker, and a bot's LGTM does not clear a human's unanswered item.

## Ledger

The human path adds these markers beside the bot loop's. Each is written with the existing write-once primitive, except the non-authoritative `pr-<n>.wait.json` sidecar, which the wait script rewrites; those marked as locked are written under the PR transition lock, whose `transition-busy` answer is retried later.

| Marker | Scope | Content |
|---|---|---|
| `pr-<n>.reviewers-<sequence>.json` | PR, locked | The selection: `[{login, id, type}]`, recorded time; the latest sequence wins |
| `pr-<n>-<head>.human-wait-<sequence>.json` | head | `startedAtMs`, `deadlineMs`; the latest sequence wins |
| `pr-<n>-<head>.human-request-<reviewer>-claim.json`, `-request.json`, `-refused.json` | head and reviewer | Request claim, then the sent marker, or the refusal marker written when GitHub refuses the request; its presence ends retries and is what `status` reports as the refusal |
| `pr-<n>.reply-<item>-claim.json` | PR, locked | Reply claim for one feedback item revision |
| `pr-<n>.feedback-<item>.json` | PR | Handled record: item id and revision, kind, URL, author `{login, id, type}`, original commit, disposition (including `author-answered` and `no-action`), reason, reply or answer URL, fix commit |
| `pr-<n>-<head>.fix-round-claim.json` | head, locked | Existing claim; gains `itemIds`, the items the round takes that the unanswered test collects (human and bot in empty mode, human under a named selection) |
| `pr-<n>.human-fix-round-slot-<k>.json` | PR, locked | One slot of the human fix cap |
| `pr-<n>.fix-waiver-<id>.json` | PR | Existing waiver; gains `kind: "human"` for a waiver of the human cap |
| `pr-<n>-<head>.approve-prompt-<reviewer>.json` | head and reviewer | The single request to press Approve on that head |
| `pr-<n>.wait.json` | PR | Non-authoritative sidecar of the wait: previous head, fingerprint, failure count |

`<reviewer>` and `<item>` are the first 16 hex digits of the SHA-256 of the account id and of the item node id with its revision, the same scheme as the existing provider-keyed request markers. Review records gain the optional fields listed under Observation shape. `status` gains `reviewers` (the selection with its request, refusal and prompt markers), `humanWait` (start and deadline of the head), `owedReplies`, and `humanFixBudget`. The per-reviewer statuses and the `unanswered` item list are not in `status`: they derive from live GitHub data and are carried by the collector packet's `humanReview` object (`humanReview.reviewers` and `humanReview.unanswered`). `status` reads only local ledger state and stays independent of GitHub.

## Failure and edge cases

| Case | Behavior |
|---|---|
| Reviewer renamed | Matched by account id; the next run writes the new login into a new selection record |
| Reviewer deleted | Status `gone`; receives no request; named in the handoff; their feedback keeps its id and URL |
| Login reused by another account | Not matched, because the id differs |
| Selected login is the PR author or an organization | `select-reviewers` refuses it |
| Review dismissed | Approves nothing; a dismissed request for changes stops counting; its items stay feedback |
| Force-push | A new head: approvals stale, one request per selected human, bot collection for the new head; a review whose commit was dropped approves nothing; items made on dropped commits keep their id, URL and the recorded original commit |
| Thread outdated | Still answered once if unanswered; never resolved by the skill; an answered outdated thread wakes nothing |
| Reviewer replies again in a thread | A new item; wakes the wait; answered once |
| Comment edited after the answer | A new revision; answered once more |
| Author answers by hand during the wait | Recognized by thread order or the item's URL; handled record `author-answered`; nothing posted |
| Fixed item seen again on the next head | Excluded by the fix-round claim's `itemIds`; no second round |
| Bot outside a named list comments | Ignored; no wake |
| Status or preview bot comments in empty mode | Assessed once as `no-action`; no reply, no fix round; edits in place wake nothing |
| Empty mode, bot reviews arrive after the head's window | Handled by the wait as feedback |
| PR closed or merged during the wait | `closed` or `merged`; the run stops and posts nothing |
| Draft PR | Bot loop and answers run; no review request; `ready` sends the owed requests |
| Review request refused by GitHub | Reported once; not retried |
| Unselected person's request for changes, all items answered, review decision still unmet | Reported as `feedback answered, waiting for <login> to re-review or dismiss`, a pending branch-rule condition and never approval; no re-review request; the run parks at the deadline; the review is never dismissed by the skill |
| Rate limit | The wait sleeps until GitHub's reset time within its window; not a failure |
| GitHub unreachable | Backoff; ten consecutive failures across windows end the wait with `error` |
| A fix cap exhausted | Stop for human reconciliation as in the bot loop; replies that claim no fix are still posted |
| Two sessions on one PR | Reads are harmless; reply and request claims, fix-round claims and delivery records are write-once or locked, so one session posts and the other gets a claimed or busy answer; a duplicate background wait only costs polls |
| Crash between a post and its marker | Settled from GitHub on resume: the reply's hidden first line, or the timeline's review-request event |
| Crash after a fix push, before its replies | `owedReplies` lists the items; the resume posts them before collecting |
| More than 100 reviews or PR comments | Paged; a connection beyond the page bound fails the collection instead of truncating |

## Security

Review text is untrusted input. The collector size-limits every body and marks it `untrusted`, and the packet only hints: the session re-reads `status` before acting. The verifier and adjudicator receive review text marked as data. Instructions in a comment (to approve, merge, push elsewhere, run a command, change scope, reveal a file) are not followed; a scope change goes to human reconciliation as in the bot loop, and only the user's own explicit request authorizes a merge.

Approval cannot be claimed in text. A comment saying an approval was given, on someone's behalf or otherwise, is feedback. A reviewer's status is `approved` only for an Approve review whose author's account id and type match a selected reviewer and whose commit is the live head, so a non-selected account cannot impersonate a selected one by login, by display name, by a `[bot]`-like name, or by quoting them. Merge-readiness comes from GitHub's own review decision, which an impersonating comment cannot change. An author answer is recognized only from the PR author's or acting account's comments, so another account cannot mark an item answered.

Replies are written by the skill from its own verdict. They carry the disposition, the evidence and commit or file references, and do not copy review text beyond the short quote needed to identify the item, so an injected string in a comment is not republished under the author's account. The skill posts only on the PR it runs for.

## Hosts and distribution

The state engine, collector and wait script are shared code; the Codex and Copilot packages carry their bundled copies as they do now, and the bundle-drift tests keep them byte-identical. The skill text is one contract with host-specific wait steps, as in the Wait table, and the skill-content tests compare the three copies. The skill's description names human reviewers as well as automated ones, so a request to address a colleague's review triggers it.

## Rationale

The bot loop already holds the parts a human review needs: a verifier that treats review text as data, a bounded and owned fix round, provenance per review, and a delivery record. A second loop for humans would duplicate all of it and drift. The human path therefore adds identity, a durable answered-feedback record, a cheap long wait, a separate fix cap and a delivery rule, and reuses everything else.

Selecting human reviewers per PR, rather than importing GitHub's requested reviewers or reading a repository configuration, keeps the awaited set the user's explicit choice: GitHub's list changes when anyone clicks, and a configuration would make one PR's choice every PR's rule. Observing every account when nobody is named makes the default safe for a PR whose reviewers the user has not thought about: nothing anyone says is missed, and nothing is waited for that the branch rules do not require. Reading GitHub's requested reviewers, a repository configuration or a built-in default bot instead would await accounts the user never chose. This changes the default for existing bot-only users who ran the skill without `--reviewer`: their default bot is no longer requested when silent and its LGTM is no longer required, and completion follows answered feedback and the branch rules. Naming the bots with `--reviewer` gives them the bot loop exactly as it is, which is what the bot-only tests run; no fallback path keeps the old default. Typing reviewers by GitHub's account type removes a setting that could disagree with reality.

The selection decides whose response is awaited and who gets re-review requests, not what counts as merge-ready. The branch rules are where a repository's maintainers state their merge requirements; a selection that also acted as a required-approver list would add a second, per-PR set of requirements that disagrees with them, and in a repository without protection the maintainers have chosen to require nothing.

Collecting feedback by whether it is answered, rather than by the head it was made on, follows from what a human comment is: an open question to the author that a push does not close. Defining answered by ledger markers and GitHub's own thread order, with the fix-round claim as one of the markers, makes the collector and the wait agree, keeps a fixed item from costing a second round, and lets an author's hand-written answer count. Collecting approvals by head follows from what an approval is: a statement about one commit.

Fixing a human's minor suggestion in the loop, while a bot's minor goes to a ticket, follows from who holds approval: a person may withhold it over a ticketed rename, a bot has none to withhold. A separate human cap keeps that extra fixing from consuming the bot cap and its bound.

Counting a head's human records as one batch in the reconciliation classification keeps a conversation of several comments from being treated as several independent reviewers that call for architecture review; P1 markers and tagged signals still raise the classification.

Waiting in a script that polls GitHub keeps the model out of a wait that is mostly silence: a model that sleeps or polls pays a request each time, while one model call per two-hour window on Claude Code costs about 13 calls a day. A per-head deadline persisted in the ledger keeps a resumed session from restarting the clock and gives each re-review request its own response time. Opening a new wait when a parked PR is resumed lets the user's explicit resume mean what it says. A deadline that parks instead of failing keeps a slow reviewer from being reported as a provider failure or as consent.

Ignoring bots outside a named list follows from naming: the user who names reviewers has said which bots matter. In empty mode every bot is heard, and assessing a status or preview comment once as `no-action`, with in-place edits not counted, keeps those notices from waking the model on every update or spending a fix round; a person's comment is always read because it may be addressed to the author.

Skipping review requests on a draft, while still answering feedback, follows the meaning of a draft: the author is not yet asking for review, but a colleague who comments early is still owed an answer.

Asking a comment-only LGTM to press Approve, instead of reading it as approval, follows the branch rules: they count a GitHub approval, and a comment is not one. Asking once avoids nagging.

Rejected alternatives:

- **Treating a human as a bot with a longer window.** The bot window ends in `review-timeout`, a failure; for a human, silence is normal. The bot packet also drops feedback made on older heads, which a human still expects answered.
- **Requiring every selected human's approval for delivery.** It turns the selection into a required-approver list that can contradict the branch rules.
- **Reading silence after a deadline, a thumbs-up, or green CI as approval.** Each lets the absence of an objection count as consent.
- **Resolving a human's thread after the fix.** It hides the exchange from the reviewer, who is the one who decides whether the fix answers the comment.
- **Reminding or re-requesting a silent reviewer.** It spends a colleague's attention to save the author a resume; the user can nudge in person.
- **Counting human review requests against the bot request budget, or human fix rounds against the bot fix cap.** One request and often one round per push is the normal human workflow; the bot budgets limit an automated loop.
- **Holding the wait in a model session, or with `Monitor`.** The first pays per poll; the second stops after 30 minutes.
- **A separate skill for human reviewers.** It would split one PR's feedback across two loops and two delivery records.

## Residual exposure

- Whether an item is actionable, conditional, an unconditional LGTM, or answered by an author comment without a link is judged by the model from untrusted text. A misjudged item is visible in the handled record and in the reply, but the script cannot detect it.
- An author comment in a thread counts as an answer even when it only asks a question back; the reviewer's next reply is a new item, so nothing is lost, but the skill does not answer in between.
- In a repository whose branch rules require nothing, a head is merge-ready before a selected reviewer responds. That is the repository's stated requirement; the handoff lists each selected reviewer's status so the user sees it.
- GitHub computes `mergeStateStatus` for the reading account, and some values are recomputed lazily. A wrong or `UNKNOWN` value delays delivery; it never makes a head mergeable, since only the listed values pass.
- A reply posted while GitHub was unreachable for the marker search may be found only on a later resume; the hidden first line prevents a second post once it is found.
- In empty mode a bot that reviews more than 15 minutes after a push misses the head's window; in a repository whose branch rules are already satisfied, the head may be delivered before that review arrives, and the review is then answered as later feedback.
- The wait polls at 60-second intervals, so a response is seen up to a minute late on Claude Code, and on Codex and Copilot only at the next explicit resume.

## Transition table

| State | Event | Outcome | Kind | Evidence |
|---|---|---|---|---|
| no selection | `select-reviewers` with a human and a bot | selection record with login, id and type each; `status.reviewers` lists both selected accounts | introduced | `select-reviewers stores login, id and GitHub type for each reviewer` |
| no selection, no `--reviewer` | first run on head H | every account observed; 15-minute window opened at first observation; no review request, grace or claim; bot request budget unspent | changed | `with no reviewer named every account is observed and no request is sent` |
| no selection, bot-only user who relied on the default bot | that bot stays silent | no manual request; its LGTM not required; completion by answered feedback and branch rules | changed | `the empty selection requests no default bot and does not await its LGTM` |
| no selection | bot posts a clean result with LGTM, an item from a person is unanswered | not complete; the item is assessed and answered | introduced | `a bot LGTM ends nothing in empty mode` |
| no selection, head H, window ended, nothing unanswered, rules satisfied | end condition | met; delivery recorded | introduced | `empty mode delivers on answered feedback and branch rules` |
| no selection | status bot posts a conversation comment | assessed once `no-action`; no reply; no fix round | introduced | `a status bot comment is no-action in empty mode` |
| no selection, bot comment handled | the bot edits that comment in place | no new revision; no wake | introduced | `an in-place edit of a bot comment wakes nothing` |
| no selection | resume without `--reviewer` | still empty; nothing answered twice | introduced | `a resume of the empty selection answers nothing twice` |
| stored named selection | `select-reviewers <pr> --none` | empty selection record; every account observed | introduced | `select-reviewers --none returns to observing every account` |
| `watch` or `collect` without `--reviewer` | poll | every account observed; no built-in fallback bot | changed | `watch without --reviewer observes every account` |
| named selection with only humans | a bot reviews | not collected; no bot window | introduced | `a humans-only list collects no bot` |
| named selection with bots | collect | the named bots form the bot list; bot loop as now | unchanged | the existing collector and state tests, which name their bot with `--reviewer` |
| named selection | an unnamed bot comments | ignored; no wake | introduced | `a bot outside a named list is ignored` |
| selection stored | resume without `--reviewer` | stored selection used; no record written | introduced | `a resume without --reviewer uses the stored selection` |
| selection stored | run with a different `--reviewer` list | new selection record; latest wins; earlier records kept | introduced | `a run that names reviewers replaces the selection and keeps the earlier record` |
| selection stored | a reviewer renamed on GitHub | new record with the new login; matching by id continues | introduced | `a renamed reviewer is matched by account id and the selection records the new login` |
| any | `select-reviewers` names the PR author or an organization | refused; nothing written | introduced | `select-reviewers refuses the PR author and an organization` |
| user account whose login equals a bot slug | it comments | treated as an unselected person; not the bot | introduced | `a user account named like a bot is not matched to the bot` |
| selected human, head H, no feedback, not a draft | first run | one review request per human; human wait opened with the 48-hour default when the session first waits, and none when the branch rules ask for nothing and nothing is unanswered, where the head is delivered at once | introduced | `a selected human is requested once and the 48-hour wait opens only when the session waits` |
| mixed selection, head H | first run | bot window, grace and claims for the bots only; humans absent from the bot packet's `pending` | changed | `the bot packet lists only bots as pending` |
| mixed selection, human silent | 15 minutes pass | no `review-timeout`; the human wait continues | introduced | `a silent human never produces review-timeout` |
| head H, selected human submits a review with inline findings | collect | one observation with each inline item as a finding with item id, kind, author and original commit | introduced | `a selected human's review becomes an observation that keeps identity, URL, commit and items` |
| head H, review body only, `CHANGES_REQUESTED` | collect | the body is one finding; not `completed-without-lgtm` | introduced | `a request for changes with only a body is feedback, not completed-without-lgtm` |
| head H, PR conversation comment by a person | collect | observation `comment-<id>` with one finding | introduced | `an actionable PR comment becomes a comment observation` |
| head H, one human review and two human comments, no P1 or signal | reconciliation packet | `light-implementation-eligible`: human records count as one | changed | `the human records of a head count as one batch in the classification` |
| head H, one bot record and one human record | reconciliation packet | `requires-architecture-review`, as for two records | changed | `a bot record plus human feedback counts as two records` |
| head H2, unanswered inline item made on H1 | collect on H2 | item enters H2's batch with `originalCommitId` H1 | introduced | `feedback made on an older head is collected on the live head with its original commit` |
| head H2, reply by a reviewer in a thread opened on H1 | collect | the reply is an item | introduced | `a reply in an older thread is feedback on the live head` |
| item fixed in H1's round, pushed to H2 | collect on H2 | excluded by the claim's `itemIds`; no second round | introduced | `an item taken by a fix round does not return in the next head's batch` |
| item claimed by a finished round, crash before its reply | resume | listed in `owedReplies`; reply posted before collecting | introduced | `owed replies of a finished round are posted on resume` |
| unselected person comments | collect | item enters the batch; assessed and answered like any other | introduced | `feedback from an unselected person enters the batch` |
| unselected person requests changes | all its items answered, repository requires reviews | Concord's work is done and no re-review request is sent; the review decision stays unmet; `feedback answered, waiting for <login> to re-review or dismiss` is a pending branch-rule condition and the run parks at the deadline | introduced | `an answered unselected request for changes leaves the branch rules unmet where reviews are required` |
| unselected person requests changes | all its items answered, repository requires no review | merge-ready by the branch rules | introduced | `an answered unselected request for changes is merge-ready where no review is required` |
| unselected person approves the live head | wait | not a selected reviewer's response; counted only through the review decision | introduced | `an unselected approval does not stand in for a selected reviewer` |
| colleague comments, author answers in the thread by hand | collect, wait | handled record `author-answered`; nothing posted; no wake | introduced | `an author's hand-written answer counts and the skill posts nothing` |
| PR comment, author quotes it by URL | collect | handled record `author-answered` | introduced | `an author comment that links the item answers it` |
| human item assessed `minor` | fix round | fixed in the head's round; reply names the commit; no `collect-minor` | introduced | `a human minor is fixed in the head's round` |
| bot item assessed `minor` | assess | `collect-minor`, reply, follow-up at delivery | unchanged | the existing minor tests |
| plan holds a human item | `claim-fix-round` | human cap slot spent; bot cap unchanged | introduced | `a round with a human item spends the human cap` |
| plan holds only bot items | `claim-fix-round` | bot cap slot spent | unchanged | the existing fix-round tests |
| human cap of five spent | `claim-fix-round` with a human item | stop for human reconciliation | introduced | `an exhausted human cap stops for reconciliation` |
| human cap spent | `waive-fix-budget <pr> <person> 2 --human` | human cap raised by two; bot cap unchanged; repeated pair changes nothing | introduced | `a human waiver raises only the human cap` |
| item assessed `rejected` or `clarify` | reply | one reply with the verdict and reason, posted without a push; thread left unresolved | introduced | `a reply that claims no fix is posted without a push and leaves the thread unresolved` |
| item assessed `blocker` | fix round, push, checks pass | one reply naming the fix commit; thread left unresolved | introduced | `a fixed item's reply names the fix commit and the thread stays unresolved` |
| reply claimed, post accepted, crash before `record-reply` | resume | reply found by its hidden first line; handled record written; no second post | introduced | `an interrupted reply is found by its marker and not posted twice` |
| reply claimed, post never reached GitHub | resume | posted once | introduced | `a reply claim with no post on GitHub posts once on resume` |
| two sessions, same item | both claim | one posts; the other gets `reply-claimed` | introduced | `two sessions answer one item once` |
| answered item | the reviewer edits it | answered once more | introduced | `an edited item is answered again once` |
| push to H2, not a draft | after push | one request per selected human; bot request budget unchanged | introduced | `each push sends one request per selected human and spends no bot request` |
| request claimed, crash before the sent marker | resume | timeline event found: marked sent; else sent once | introduced | `an interrupted review request is settled from the timeline` |
| GitHub refuses a request | request | `request-refused:<login>` reported once; not retried | introduced | `a refused review request is reported once and not retried` |
| head pushed by someone else | wait | `head-moved`; collection for the new head; one request per selected human | introduced | `a push by another account makes approvals stale and requests re-review once` |
| draft PR, human feedback | collect | feedback assessed and answered; bot loop runs; no review request | introduced | `a draft answers feedback but sends no review request` |
| draft PR, waiting | PR marked ready | `ready`; owed requests for the live head sent once | introduced | `ready for review wakes the wait and sends the owed requests` |
| draft PR | deadline passes | park; handoff says no review request was sent and requests go out when ready | introduced | `a parked draft's handoff says requests wait for ready` |
| waiting on H, deadline not passed | window of 6600 seconds ends | `idle`; same command run again; nothing posted | introduced | `wait-feedback --max-wait ends a silent window with idle` |
| waiting | a reaction, a label or a CI change that leaves the merge state | no wake | introduced | `reactions, labels and CI changes do not wake the wait` |
| waiting | new item from a person | `feedback` | introduced | `a new item wakes the wait with feedback` |
| waiting | review decision or merge state changes | `rules-changed` | introduced | `a change of review decision or merge state wakes the wait` |
| waiting on H, deadline in the future, session replaced | resume | same deadline; clock not restarted | introduced | `a resumed wait keeps the persisted deadline` |
| parked on H at a passed deadline | resume | new wait for H with a new start; not parked again at once | introduced | `resuming a parked PR opens a new wait` |
| waiting on H | `--human-wait 24` on resume | deadline moved from the current start; later heads use 24 hours | introduced | `--human-wait moves the current deadline from the current start` |
| waiting on H, rules unmet | deadline passes | `deadline`; park; no delivery; handoff says human review pending and not approval | introduced | `the deadline parks the run without a delivery and reports human review pending` |
| waiting | GitHub fails ten polls across windows | `error` | introduced | `ten failed polls across windows end the wait with error` |
| waiting | rate-limit response | sleeps until reset within the window; failure count unchanged | introduced | `a rate-limit response is not counted as a failure` |
| selected human approved H1 | push to H2 | `stale-approval`; one request | introduced | `an approval of an earlier head is stale for the new head` |
| Approve review whose commit was dropped by a force-push | collect | approves nothing | introduced | `a review whose commit is gone approves nothing` |
| Approve review on H dismissed | collect | approves nothing | introduced | `a dismissed approval approves nothing` |
| selected human comments "LGTM" with no condition | assess | one reply asking to press Approve; `approve-prompt` marker; not approval | introduced | `a comment-only LGTM gets one request to press Approve and is not approval` |
| `approve-prompt` exists for H | the same reviewer comments "LGTM" again | no second prompt | introduced | `the Approve prompt is sent once per reviewer and head` |
| selected human comments "LGTM, but fix X" | assess | feedback; never approval | introduced | `a conditional LGTM is feedback` |
| generic thumbs-up from a selected human | any | never LGTM; no wake | introduced | `a reaction is never human approval` |
| mixed, bot LGTM, repository requires a human approval | end condition | `reviewDecision` not `APPROVED`; wait continues | introduced | `a bot LGTM does not satisfy branch rules that require a human approval` |
| no branch protection, nothing unanswered, bots terminal, selected human silent | end condition | met; delivery recorded `mergeable-*` with the human's status `pending` | introduced | `an unprotected repository is merge-ready by its branch rules without the selected reviewer` |
| rules satisfied, nothing unanswered | deliver | delivery recorded with `humanReview`; `mergeable-*` | introduced | `delivery with satisfied branch rules and no unanswered item is mergeable` |
| bot-only packet | `record-delivery` | no `humanReview`; same digest and classification as the bot loop | unchanged | `a bot-only delivery packet keeps its digest` |
| `merge-ready`, human entry, rules unmet | gate | `branch-rules-unmet`; no `no-lgtm` for the human entry | changed | `merge-ready reports branch rules for human reviewers` |
| PR merged or closed during the wait | poll | `merged` or `closed`; nothing posted | introduced | `a merged or closed PR ends the wait` |
| reviewer account deleted | resume | `gone`; no request; named in the handoff | introduced | `a deleted reviewer is gone and receives no request` |
| PR with more than 100 comments | collect | all pages read; beyond the bound the collection fails | changed | `PR comments and reviews past the first page are collected` |

A bot never receives a human review request, a human never enters the bot request budget, and a round's cap follows from whether its plan holds a human item; all three follow from the stored reviewer type and the plan, so no row combines them.

## Acceptance criteria and fixtures

Each criterion of the extension maps to collector fixtures (GraphQL responses in the shape of the existing `fixtures/review-collector` file), state-engine cases, and skill-content assertions:

| Criterion | Fixture cases (transition-table evidence) |
|---|---|
| Explicit selection of humans, bots or a mixed set, keeping identity and links | `select-reviewers stores login, id and GitHub type for each reviewer`; `with no reviewer named every account is observed and no request is sent`; `a humans-only list collects no bot`; `select-reviewers --none returns to observing every account`; `a selected human's review becomes an observation that keeps identity, URL, commit and items`; `a renamed reviewer is matched by account id ...`; `a user account named like a bot is not matched to the bot` |
| A selected human's review, inline finding, reply or actionable PR comment enters the workflow; an unrelated person's comment is not that reviewer's approval | `a request for changes with only a body is feedback ...`; `an actionable PR comment becomes a comment observation`; `a reply in an older thread is feedback on the live head`; `an unselected approval does not stand in for a selected reviewer`; `feedback from an unselected person enters the batch`; `a bot outside a named list is ignored`; `a status bot comment is no-action in empty mode`; `the human records of a head count as one batch in the classification` |
| Evidence-backed replies, with the fix commit when applicable; rejected and deferred feedback keeps reason and provenance; threads stay unresolved | `a fixed item's reply names the fix commit and the thread stays unresolved`; `a human minor is fixed in the head's round`; `a reply that claims no fix is posted without a push ...`; `an interrupted reply is found by its marker and not posted twice`; `an author's hand-written answer counts and the skill posts nothing` |
| After a push, human re-review is pending and resumes without losing findings, duplicating replies or requests, or resetting budgets | `each push sends one request per selected human and spends no bot request`; `an interrupted review request is settled from the timeline`; `a resumed wait keeps the persisted deadline`; `resuming a parked PR opens a new wait`; `an item taken by a fix round does not return in the next head's batch`; `owed replies of a finished round are posted on resume`; `a round with a human item spends the human cap`; `a human waiver raises only the human cap` |
| A delayed human response follows the waiting policy, is not a provider failure or approval; silence and reactions never yield LGTM | `a silent human never produces review-timeout`; `wait-feedback --max-wait ends a silent window with idle`; `the deadline parks the run without a delivery ...`; `a reaction is never human approval`; `a comment-only LGTM gets one request to press Approve ...`; `ready for review wakes the wait and sends the owed requests` |
| A human approval belongs to its commit; a later push cannot reuse it; requests for changes stay visible | `an approval of an earlier head is stale for the new head`; `a review whose commit is gone approves nothing`; `a dismissed approval approves nothing`; `an answered unselected request for changes leaves the branch rules unmet where reviews are required`; `an answered unselected request for changes is merge-ready where no review is required` |
| In a mixed set, a bot LGTM cannot mask a pending human review or an unresolved blocker; delivery reports each reviewer's status | `a bot LGTM does not satisfy branch rules that require a human approval`; `an unprotected repository is merge-ready by its branch rules without the selected reviewer` (asserting the `pending` status in `humanReview.reviewers`); `delivery with satisfied branch rules and no unanswered item is mergeable` |
| Bot-only collection, reconciliation, ownership, budget and delivery behavior stays covered for named bots; the default without a named reviewer observes every account | the existing collector and state tests, with the bot they rely on named by `--reviewer`; `watch without --reviewer observes every account`; `the empty selection requests no default bot and does not await its LGTM`; `empty mode delivers on answered feedback and branch rules`; `a bot LGTM ends nothing in empty mode`; `the bot packet lists only bots as pending`; `a bot record plus human feedback counts as two records`; `a bot-only delivery packet keeps its digest` |

The bot collector and watch tests name the bot they exercise with `--reviewer`, since no fallback reviewer exists. The fixture set covers the empty selection (humans and several bots, including a status bot that edits its comment), human-only and mixed selections, delayed feedback (a review arriving after several idle windows), repeated feedback (a second reply in one thread, an edited comment), comment replies (the skill's replies and the author's own), stale approvals, head changes (the skill's push, another account's push, a force-push that drops the reviewed commit), draft and ready transitions, and interruption and resume (a crash after a reply post, after a request, after a fix push before its replies, a session replaced mid-wait, and a resume after a park). The skill-content tests assert the wait commands per host, the absence of `Monitor` for the human wait, the never-resolve rule for human threads, the single Approve prompt, the human minor fix rule, and that the Codex and Copilot copies match the shared skill.
