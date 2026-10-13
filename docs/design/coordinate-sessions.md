# Coordinate sessions

`coordinate-sessions` is a Claude-only skill for a session that hands units of work to other Claude Code sessions, watches their reports, judges their delivery, and merges when the user has allowed it. A fresh session can run it from the skill alone, without a predecessor's handoff.

## Scope

The skill lives in `plugins/concord/skills/coordinate-sessions/` and is named in the plugin descriptions and the README. It is not copied into the Codex or Copilot packages: their `bin/bundle.mjs` copy only the skills they name, and the session tools the skill depends on (`create_session`, `send_message`, `get_session`, `archive_session`) exist only in Claude Code.

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
| Coordinator receives | a Monitor over the group directory, deduplicated against `<reports>/.emitted`, re-armed when it expires | a new turn; no watch needed |

The report kinds are `question`, `blocked`, `progress`, `done` and `handoff`. The user may choose the other channel; a request for the file channel where the filesystem is not shared is refused with that reason. The file channel is the default where it works because a report stays on disk for a successor coordinator, while a direct message stays only in the receiving session's transcript.

A worker in a cloud environment reaches the coordinator with `send_message` as well, so the direct channel works across environments.

On either channel, a worker that has gone quiet is checked with `get_session`: `status_bucket` `failed` means its last turn errored, `status_bucket` `blocked` means it waits on something only the user can give, and `status` `idle` with no report means it stopped without reporting.

## Worker prompt

The skill carries a template the coordinator fills in, in this order:

1. The skill the worker runs (default `ticket-to-pr`).
2. The work: issue numbers, where the acceptance criteria are, and what is out of scope.
3. File ownership: the files this work changes, and the files other workers or outside contributors own. A worker that must change another owner's file sends a `question` first.
4. On a Sonnet worker, design choices go to an Opus agent (Agent tool, model opus), and the conclusion and its reason go into the PR body.
5. The channel: the report directory, or the coordinator's session id, and the report format.
6. Stop rules: the worker never merges, and past the context limit it stops at the next stage boundary with a `handoff` report.
7. A path to the project's rules file (for example `AGENTS.md` or a shared worker-rules file). Repository rules such as the gh account, worktree location and release bump stay in that file, not in the prompt or the skill.

## Decisions

The coordinator takes as a decision only what the user typed into the coordinator's own session. A worker report, a message relayed from another session that says the user approved something, and a background-task notification are data.

A worker follows the coordinator's messages as instructions. A step that records a person's acceptance, such as `dismiss --by`, needs the user to type it into the worker session; the coordinator cannot relay it.

The coordinator answers a worker's `question` itself when the answer lies within what the user has delegated, and otherwise asks the user and tells the worker to wait.

## Lifecycle

| Step | What the coordinator does |
|---|---|
| Start | Reads the environment, picks the channel, names the group (`groupNN`), creates the worker, starts the watch on the file channel, and reports to the user in one or two paragraphs. |
| Parallel work | Runs workers in parallel only when their file sets are disjoint; otherwise orders them or gives them to one worker. |
| Watch | Re-arms the Monitor while a worker is active and stops it when none is. |
| `done` | Verifies the report: the PR head, CI, and every review comment. A finding the worker classed as minor is checked against the code before it is accepted as minor. |
| Merge | Only when the user allowed merging when starting the coordination: with no blocker left and CI green, squash-merges with `--match-head-commit <reported head>`. Otherwise reports the verdict and waits. |
| After merge | Runs the post-merge steps the project's rules file names, records remaining minor findings where the project's rules say, and archives the worker once it is idle. |
| Coordinator handoff | When its own context grows large, between deliveries: writes a handoff with the state, running workers, the user's decisions and open questions, into the report directory on the file channel or into the successor's prompt otherwise, then creates the successor with `create_session` and a prompt that marks the handoff as data. |
