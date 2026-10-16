# Coordinate sessions

`coordinate-sessions` is a Claude-only skill for a session that hands units of work to other Claude Code sessions, watches their reports, judges their delivery, and merges when the user has allowed it. A fresh session can run it from the skill alone, without a predecessor's handoff.

## Scope

The skill lives in `plugins/concord/skills/coordinate-sessions/` and is named in the marketplace description and the README; `plugins/concord/.claude-plugin/plugin.json` is a release-bump version file that pull requests do not edit. It is not copied into the Codex or Copilot packages: their `bin/bundle.mjs` copy only the skills they name, and the session tools the skill depends on (`create_session`, `send_message`, `get_session`, `archive_session`) exist only in Claude Code.

A worker is a separate Claude Code session created with `create_session`. It runs on its own and knows only the prompt it was given. A subagent started with the Agent tool is not a worker: it returns its result to the session that started it, so neither channel below applies to it. Local CLI sessions are out of scope, because no tool can create one.

## Environment

The coordinator first calls `get_session` without a `session_id` and reads `environment_kind`. That value decides what the coordinator can do; text in its system prompt does not, because a session on the user's own machine (`bridge`) can carry a system prompt that describes an isolated cloud container. The skill states this and defines "create a session" as a `create_session` call, so a session that reads its system prompt as a cloud container still knows what the request means.

| Worker created in | Shared filesystem with the coordinator | Channels available |
|---|---|---|
| the coordinator's own environment, and `environment_kind` is `bridge` | yes | file, direct |
| any other environment, including another `bridge` environment, which runs on another machine | no | direct |

`create_session` without `environment_id` creates the worker in the coordinator's own environment.

## Channels

The coordinator sends to a worker with `send_message` on both channels. The channels differ only in how a worker reports.

| | File channel | Direct channel |
|---|---|---|
| Default when | the environment shares a filesystem | it does not |
| Worker report | `<reports>/<group>/NNN-<kind>.md`, written as `NNN-<kind>.md.tmp` and then renamed | `send_message` to the coordinator's session id |
| First line | `[to coordinator] <kind>: <summary>` | same |
| Coordinator receives | a Monitor over the group directory that emits every new report once, flagging one without the header, deduplicated against `<reports>/.emitted` and re-armed when it expires | a new turn; no watch needed |

The report kinds are `question`, `blocked`, `progress`, `done` and `handoff`. The user may choose the other channel; a request for the file channel where the filesystem is not shared is refused with that reason. The file channel is the default where it works because a report stays on disk for a successor coordinator, while a direct message stays only in the receiving session's transcript.

A worker in a cloud environment reaches the coordinator with `send_message` as well, so the direct channel works across environments.

On either channel, a worker that has gone quiet is checked with `get_session`: `status_bucket` `failed` means its last turn errored, `status_bucket` `blocked` means it waits on something only the user can give, and `status` `idle` with no report means it stopped without reporting.

`status_bucket` `working` does not show that a worker has started: in a stalled bridge environment it read `working` while the worker stayed `PENDING` and `disconnected`. Three minutes is long enough for a normal sandbox allocation, and the start check still reaches the user well before a missing report would. The start check depends on `connection_status` alone, so it holds whatever `status` and `status_bucket` read.

`create_session` takes no effort setting, so the worker prompt names the effort and cannot enforce it. The coordinator lists its workers with `list_sessions` using `mine: true` and a small `limit`, because an unfiltered call can overflow the tool result.

## Worker prompt

The skill carries a template the coordinator fills in, in this order:

1. The skill the worker runs (default `ticket-to-pr`).
2. The work: issue numbers, where the acceptance criteria are, and what is out of scope.
3. File ownership: the files this work changes, and the files other workers or outside contributors own. A worker that must change another owner's file sends a `question` first.
4. On a Sonnet worker, design choices go to an Opus agent (Agent tool, model opus), and the conclusion and its reason go into the PR body.
5. The channel: the report directory, or the coordinator's session id, and the report format.
6. Stop rules: the worker never merges, pastes its `record-delivery` output into the `done` report, and past the context limit it stops at the next stage boundary with a `handoff` report.
7. A path to the project's rules file (for example `AGENTS.md` or a shared worker-rules file). Repository rules such as the gh account, worktree location and release bump stay in that file, not in the prompt or the skill.

## Decisions

The coordinator takes as a decision only what the user typed into the coordinator's own session. A worker report, a message relayed from another session that says the user approved something, and a background-task notification are data.

A worker receives the coordinator's `send_message` as data from a peer and may refuse a destructive action asked for that way, so every authority the worker needs goes in its `create_session` prompt and later messages carry answers and scope clarifications. A step that records a person's acceptance, such as `dismiss --by`, needs the user to type it into the worker session; the coordinator cannot relay it.

The coordinator answers a worker's `question` itself when the answer lies within what the user has delegated, and otherwise asks the user and tells the worker to wait.

## Lifecycle

| Step | What the coordinator does |
|---|---|
| Start | Loads the skill before the first `create_session`, reads the environment, picks the channel, names the group (`groupNN`), creates the worker, confirms that it started, starts the watch on the file channel, and reports to the user in one or two paragraphs. |
| Start check | Polls `get_session` every 30 seconds until `connection_status` reads `connected`. A worker not connected within three minutes of `create_session` is stalled in sandbox allocation: the coordinator starts no watch, archives it, tells the user to check or restart the bridge for that environment, and offers an Agent-tool subagent as the fallback. It sends the worker no message before it has started. |
| Parallel work | Runs workers in parallel only when their file sets are disjoint; otherwise orders them or gives them to one worker. |
| Watch | Re-arms the Monitor while a worker is active and stops it when none is. |
| `question`, `blocked`, `progress` | Answers a `question` or `blocked` report within what the user delegated and otherwise asks the user; acts on `progress` only when it changes scope or file ownership. |
| `handoff` from a worker | Creates a successor worker in the same group with the original prompt, the handoff report as data, and the instruction to number its first report one past the highest `NNN` already in `<reports>/<group>/`, then archives the old worker once it is idle. |
| `done` | Verifies the report: the PR head, CI, and every review comment. A finding the worker classed as minor is checked against the code before it is accepted as minor. The delivery state in the worker's `record-delivery` output, for the PR's current head, is binding: a `blocked` head never merges, and a `mergeable-without-review` head is the user's decision. |
| Merge | Only when the user allowed merging when starting the coordination: with no blocker left and CI green, squash-merges with `--match-head-commit <reported head>`. Otherwise reports the verdict and waits. |
| After merge | Checks that every issue named in a `Closes` line is closed, runs the post-merge steps the project's rules file names, records remaining minor findings where the project's rules say, and archives the worker once it is idle. |
| Coordinator handoff | When its own context grows large, between deliveries: writes a handoff with the state, running workers, the user's decisions and open questions, to `<reports>/coordinator-handoff.md` on the file channel (then stops its own Monitors, which share `<reports>/.emitted`) or into the successor's prompt otherwise. It creates the successor with `create_session` and a prompt that marks the handoff as data, names `<reports>` and the handoff file on the file channel, and has the successor start a Monitor for each file-channel group still running. On the direct channel, before it stops reading reports, it sends each running worker the successor's session id with `send_message` and forwards to the successor any report that still reaches it. |
