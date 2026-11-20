---
name: review-until-approve
description: >-
  Use when the user names someone else's pull request and wants it reviewed until it can be approved: each round runs a confined reviewer and a confined verifier and publishes one review, and the reviewed head is approved once nothing blocks; a background watcher with no model call runs the next round when the author pushes or replies, and approves when the pull request becomes ready —
  "이 PR 승인될 때까지 리뷰해줘", "review this PR until it is approvable", "watch acme/app#57 and approve when clean", "stop watching acme/app#57".
  Do NOT use for your own branch (use review-and-fix) or to collect other reviewers' comments on your own PR (use pr-to-merge).
---

# Review until approve

You run the script that reviews a pull request someone else wrote, relay what it prints, and ask the user the questions it reports. The script does the review without you: a confined reviewer and a confined verifier read the pull request in a directory you never open, and the script publishes what survives as one GitHub review whose last line holds the whole state. It approves the reviewed head when nothing blocks. It never requests changes, merges, or pushes.

Invoking this skill on a pull request authorizes every review the script posts there, the approval included, the decision comments `decide` posts, the changes to the `review-blocked` label, and putting the pull request on the watch list, from which the background watcher runs those rounds and approvals without the user present. Use it only for a pull request the user named.

## What you never do

- Never read the pull request's content: no `gh pr view`, `gh pr diff`, `gh api` of its files, comments or reviews, no web page, no checkout. The user reads the findings on the pull request.
- Never read, list, or open the round directory, the agents' files, the script's log, or anything under Concord's per-user state directory. The script prints no path to them.
- Never edit, wrap, or replace the script or its request files, and never run the agents yourself.
- Relay only what a printed line holds: its event, counts, keys, head hashes, and links. Nothing else about the pull request comes from you.

## Setup

- `SCRIPTS` is the `scripts/` directory next to this file. Resolve it in the same shell command as every call, never from an earlier one, since a plugin update can remove an older version directory: `SCRIPTS=$(LOCATOR) && [mien exec <profile> -- ]node "$SCRIPTS/review-until-approve.js" <verb> <owner/repo> <n> ...`. LOCATOR is this one-line Node command, which searches only the installed plugin caches (never the reviewed checkout) and prints the `scripts/` directory of the newest installed Concord version: `node -e "const fs=require('fs'),p=require('path'),o=require('os'),q=[p.join(o.homedir(),'.claude','plugins','cache'),p.join(o.homedir(),'.codex','plugins','cache')],c=[];function a(f){let d=p.dirname(f);for(;;){for(const k of ['.claude-plugin','.codex-plugin']){let m;try{m=JSON.parse(fs.readFileSync(p.join(d,k,'plugin.json'),'utf8'))}catch{continue}if(m.name==='concord'&&typeof m.version==='string')c.push([m.version,p.dirname(f)]);return}const u=p.dirname(d);if(u===d)return;d=u}}for(const d of q){const s=[d];while(s.length){const x=s.pop();let z;try{z=fs.readdirSync(x,{withFileTypes:true})}catch{continue}for(const e of z){const f=p.join(x,e.name);if(e.isFile()&&e.name==='review-until-approve.js'&&p.basename(p.dirname(f))==='scripts'&&p.basename(p.dirname(p.dirname(f)))==='review-until-approve')a(f);if(e.isDirectory())s.push(f)}}}function w(s){s=s.split('+')[0];const k=s.indexOf('-');return k<0?[s,[]]:[s.slice(0,k),s.slice(k+1).split('.')]}function r(x,y){const[a,b]=[x,y].map(w),n=a[0].split('.'),m=b[0].split('.');for(let i=0;i<3;i++)if((+n[i]||0)!==(+m[i]||0))return (+n[i]||0)-(+m[i]||0);if(!a[1].length||!b[1].length)return b[1].length-a[1].length;for(let i=0;i<Math.max(a[1].length,b[1].length);i++){const e=a[1][i],g=b[1][i];if(e===undefined)return -1;if(g===undefined)return 1;const t=String(+e)===e,u=String(+g)===g;if(t!==u)return t?-1:1;if(e!==g)return t?e-g:e<g?-1:1}return 0}c.sort((x,y)=>r(x[0],y[0]));if(c.length)console.log(c[c.length-1][1]);else process.exit(1)"`.
- Every call runs as the reviewing account: when the user names a profile, the prefix `mien exec <profile> --` goes after the assignment, directly before `node` (the locator needs no account); otherwise the ambient `gh` account reviews. That account must not be the pull request's author.
- The agents are the harness's own: `claude -p` under Claude Code, `codex exec` under Codex. Pass `--harness claude` or `--harness codex` to match the harness you run in. Never pick the other vendor.
- `round` calls GitHub, fetches the pull request with `git`, and starts the agents; give it network access and run it in the foreground with the longest timeout your harness allows (Bash `timeout: 600000` under Claude Code): a round runs two agents of up to 30 minutes each, each run once more on a malformed output. If the harness moves the command to the background, wait for it to end and start no second one; if it is stopped, it removes its round directory and frees its lock. It needs Node, `gh`, `git`, and the harness's CLI.
- If a command is denied (an auto-mode classifier or a permission prompt), relay the denial to the user and stop; do not retry it or look for another way.

## A round

On every invocation, first run `watch add <owner/repo> <n> --harness <claude|codex>`, outside any sandbox (the watcher keeps the sandbox of the process that starts it), with the `--model` and `--effort` the user asked for (below), then `round <owner/repo> <n> --harness <claude|codex>` with the same options. `round` runs a round when something is pending: no review yet, a new head, a reply from the author or an account with write access, or a changed description. With nothing pending it approves the reviewed head when the condition holds, and otherwise prints `nothing`. A round the user invokes runs even when the watcher is holding back a failed one. After that, the watcher waits for the author (see Waiting); you do not.

Each line is one JSON object. Say one line per event to the user:

- `published`: a review was posted. `review` is `APPROVE` or `COMMENT`; give the counts (`new`, `fixed`, `answered`, `open`, `asked`, `blockers`) and the `link`. On a `COMMENT`, `why` lists what withheld approval: `blocker`, `unreadable`, `submodule`, `draft`, `head-moved` (the head moved during the round; the new head is pending), `overflow`, `approved`, `closed`, `author`. `carried: true` means a base merge left the pull request's diff unchanged, so the state was carried forward with no agent.
- `nothing`: nothing was pending and the head cannot be approved yet; `why` says why.
- `superseded`: another round on this pull request published first; nothing was posted. Run `round` again.
- `locked`: another round or decision on this pull request and account is running. Wait for it; do not start a second one.
- `failed`: the round posted nothing. `reason` is `reviewer-output` or `verifier-list` (an agent's output was malformed twice, or the verifier's list failed the script's checks twice; it counts against the daily cap), `prepare`, `submission`, or `refused`. Tell the user; what was pending stays pending.
- `merged`, `closed`: tell the user; there is nothing more to review.
- `error`: `author` (the account is the pull request's author), `github`, or `internal`. Tell the user and stop.
- `question`: ask the user, as below.

`state <owner/repo> <n> --harness <claude|codex>` prints the same view without acting: `pending`, whether the head is `approvable`, `why` not, the counts, and the questions.

## Waiting

`watch add` puts the pull request on the watch list with the account `gh` is logged in as and the harness, model, and effort, and starts the background watcher unless it runs. Say what it prints:

- `watching` with `pr`: the pull request is on the list.
- `watcher` with `started: true`: the watcher was started; `running: true`: it was already running. Both mean that rounds now run without a session.
- `watcher` with `reason: probe`: the state directory or GitHub could not be reached from here (a harness sandbox), so nothing was added or started. Give the user the same `watch add` command, with the `scripts/` directory resolved, to run in a terminal.

The watcher checks every five minutes with `gh` and no model. A push, a reply, or a description edit runs a round once the head and the replies have stayed unchanged for one check; a pull request made ready after a clean review is approved with no agent; a merged or closed one leaves the list. It runs at most six agent rounds per pull request in 24 hours, does not retry a failed round until something changes, and writes what it did to Concord's notice list, which the session-start message shows.

`watch status --harness <claude|codex>` prints whether the watcher runs (`watcher`, `running`), each watched pull request with the time of its last check (`watching`, `pr`, `checked`), and each pending line (`notice`). Relay them. A `notice` line starts with the pull request:

- `approved round <r> at <head>: ...` and `reviewed round <r> at <head>: ...`: a review the watcher published, with its counts and link.
- `round failed: <reason>`: a round posted nothing (reasons as under `failed` above). The watcher waits for something new; invoking the skill retries at once.
- `merged; no longer watched`, `closed; no longer watched`: the pull request left the list.
- `review-blocked label restored`: the label was removed while a blocker is open, and the watcher added it back.
- `question <ask> ...`: a question, as under Questions; `question account <login>` means `gh` is now logged in as another account than `<login>`, the account the pull request was added with, so the watcher skips it until that account is back or the user invokes the skill as the account they want. Ask the user. A question line stays pending until it is answered: by `decide`, by a round that settles it, or by the user's next invocation on that pull request. `watch status` marks every other line shown.

When a session starts with `review-until-approve:` lines, or says the watcher is not running, run `watch status` and relay it; invoking the skill on a pull request starts the watcher again.

The user's stop ("stop watching acme/app#57", "그 PR 그만 봐") is `watch remove <owner/repo> <n> --harness <claude|codex>`: it prints `unwatched`, removes the entry and its pending lines, and posts nothing. Nothing else stops the watcher on a pull request but its merge or close.

## Questions

A `question` line names what it asks with `ask`. Ask the user in one message, give the `link`, and act only on their answer in their own words.

- `asked`: findings `keys` turn on judgment and wait for the user. The user reads them on the pull request and decides each one (see Decisions).
- `unreadable`: one of the account's own reviews or comments was edited, or cannot be parsed, so the state on the pull request cannot be trusted. Nothing is approved and `review-blocked` stays until the user rules: `decide <owner/repo> <n> continue --reason '<words>'` carries the newest unedited state forward; `start-over` discards the state, and the next round reviews the whole pull request.
- `submodule`: `submodules` gitlink changes are not reviewed, and approval waits for the user's yes on each. The user reads the path on the pull request; on a yes, run `decide <owner/repo> <n> submodule:<path> accept --reason '<words>'` with the path the user gives.
- `agent-cannot-start`, `hook-did-not-run`: the confined agent could not run (the CLI is missing or not logged in, the Codex sandbox did not refuse the home directory, or the read-only hook did not run). Nothing was posted. Tell the user what to check; never run the agent another way.
- `cap`: `rounds` agent rounds ran in the last 24 hours; no seventh runs. Tell the user; a later invocation runs once the window allows.
- `account`: the account cannot read the pull request. Ask the user which account to use; never choose another account or profile yourself.
- `overflow`: the review exceeded GitHub's size limit, so it does not approve. Tell the user.

## Decisions

Only the user decides a finding. Run `decide <owner/repo> <n> <key> keep|waive|blocker|minor --reason '<the user's reason, in their words>'` when the user gives one: `waive` closes the finding, `blocker` or `minor` changes its class, `keep` keeps it open (an `asked` finding becomes `open`). The script posts the decision as a comment with the reason quoted and prints `decided`, then approves when the condition holds (a `published` line). `failed` with `reason-refused` means the reason would act on GitHub (a line starting with `/` or a bot command word) or holds a credential, and nothing was posted: ask the user to reword it. A refused command (an unknown key, no reason, nothing to rule on) exits 2 with one line on standard error and posts nothing. Never decide on your own judgment, never compose the reason yourself, and never pass a reason the user did not give in this conversation.

## Options the user asks for

Set an option only on the user's explicit request; never infer one from the language the user writes in.

| The user says | Option |
|---|---|
| "한글로", "한국어로", "in Korean" | `--language ko` (a BCP 47 tag; "in English" is `en`). It is kept in the state, so later rounds use it |
| "opus", "sonnet", "haiku", or another model name of the harness's vendor | `--model <name>` |
| "low", "medium", "high", "xhigh", "max", "고강도로" (high), "최대로" (max) | `--effort <level>` |

"Thorough" and "꼼꼼히" are not an effort request. Ask one question when the request conflicts (a model of the other vendor) or no single value fits. `--model` and `--effort` apply to the round you run and, through `watch add`, to the watcher's rounds on that pull request; pass them again on each invocation the user wants them for, since `watch add` without them returns the watcher to the harness's default.

## What a review holds

One review per published round, pinned to the reviewed head, with event `COMMENT` or `APPROVE`. New findings whose quoted span lies in the diff are line comments, each starting with its marker; the rest are in the body with file and line. The body lists, by key, the findings for the reviewer to decide, the fixed, the answered, and the still-open ones with links to their threads, the unreviewed submodules, the Unverified items, and, on an approval, the open minor findings as follow-ups. Agent text is escaped and quoted; paths and quoted spans are in fenced blocks. Each fixed or answered thread gets one reply from the script and is resolved; a reopened one is unresolved. `review-blocked` is on exactly while a blocking finding is open or asked, or the state is unreadable.
