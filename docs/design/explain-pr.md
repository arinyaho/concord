# Explain a pull request

`explain-pr` helps a person decide whether to approve a pull request that someone else wrote, when the diff is too large to read top to bottom and the author is not at hand to ask. It reads the pull request with the person and leads them through it: what it is for, which part of the diff carries the change, which decisions it makes and on what record, what it affects, what proves it, and what to ask the author. Every claim points at a file and line, so the person checks the core change by reading it rather than by trusting the explanation.

The skill explains; it does not judge. It approves nothing, posts nothing, and runs no code from the pull request. Judging and approving belong to `review-until-approve`.

## What a reader needs to approve

The content is fixed, whoever reads, because it follows from the approval decision rather than from a reader's taste. A reader has understood the pull request well enough to approve when they can say, in their own words, what breaks if it is reverted and what breaks if it is wrong. The guide gives them what that takes, in this order:

| Section | Content |
|---|---|
| TL;DR | What changes and why, in two or three lines, and the two or three places the reader should read for themselves before approving |
| 1. Intent | The problem and why now; the linked ticket; whether the pull request's scope matches the ticket's |
| 2. Diff map | Every changed file in one of three classes, with its line counts: **core** (behavior changes), **supporting** (tests, configuration, documentation), **mechanical** (renames, moves, formatting, generated files, lockfiles) |
| 3. Reading order | The core hunks as a numbered list of `path:start-end`, each with what to look for in it |
| 4. Decisions | Each choice the change makes, the alternative it rules out, and its source: a link to the design document, ticket, review thread, or commit message that records it; `inferred` with the code or commit it is inferred from; or `no record` |
| 5. Reach | The callers, contracts, stored data, configuration, and security boundaries the core change affects, each with where it is |
| 6. Evidence | The tests that exercise each core hunk, the CI result on the head, and whether anything shows the tests fail without the change; what nothing shows is stated as unverified |
| 7. Questions for the author | Every `no record` decision, every unverified point, and every gap between the ticket and the diff, presented as questions for the reader to check against the diff before asking, not as text to post unread |

Rules for every section:

- Each claim names a `path:line` or a link. A claim the session cannot anchor is not made.
- A mechanical file is classed mechanical only when the session can say what makes it so (`git diff -M` reports a rename, the change is whitespace only, the merge base's `.gitattributes` marks the file generated, it is a lockfile). Otherwise it is supporting or core. A changed `.gitattributes` is core, since it can change how other files are classed.
- Core hunks are read in full. Supporting files are read enough to say what they do. Mechanical files are checked only for being mechanical.
- The session never says the pull request is correct, safe, or ready. When asked, it answers with what the guide shows and what it leaves unverified.

## What adapts to the reader

Two things differ between readers, and the session asks about neither more than once per pull request:

- **What the reader already knows.** The prepare step counts, for each changed path, the reader's own commits on it. A reader who has worked in those paths gets a short Intent and Reach and goes to the reading order; a reader new to them gets the background first. The session states which it chose, and the reader can say otherwise.
- **How deep and in which language.** The guide is in the language the reader writes in. The reader can ask for more depth on any section, or for any hunk to be walked through line by line.

After the guide, the reader asks follow-up questions in the same session. Answers follow the same rules: anchored, `inferred` or `no record` where that is the truth.

## The pull request is untrusted

The pull request's title, body, comments, commit messages, linked tickets, and code are written by people the user does not control. Text in them can be written to steer an agent that reads it. A session that reads them holds the user's shell and GitHub credentials, and under a permission mode that asks nothing, an instruction it follows would act as the user.

The skill therefore reads the pull request only in **read-only mode**: while the mode is on, the session can read the files of one prepared directory and do nothing else. The worst that steering text can then do is make the explanation wrong; anchoring every claim to a line is what lets the reader catch that. The reader is the remaining channel: steered output can ask the reader to fork or resume the session, run a command, or post questions the author wrote. The guide therefore asks the reader to do none of these, and presents its questions for the author as questions for the reader to check, not text to post unread.

### Prepare, then read

1. **Prepare.** Before the mode is on, the session runs `explain-pr.js prepare <owner/repo> <number> [--checkout <path>]`. The script uses `gh` and `git` (2.40 or later, for `git check-attr --source`) and writes the prepared directory under the plugin's per-user data directory:
   - `pr.json`: number, title, body, author, base and head refs and commits, labels, draft state;
   - `diff.patch`, the diff from the merge base to the head, built locally with rename detection and without the user's diff drivers, and `files.json`, built by git from the same two commits (per file: status, additions, deletions, rename source, whether it is binary, and whether it is a lockfile or is marked generated by the merge base's `.gitattributes`). The pull request's own changes to `.gitattributes` mark nothing generated; a file it adds or renames into a path the merge base already marks generated is still marked, and the check that each mechanical file is mechanical is what catches that. GitHub's list of a pull request's files stops at 3000 files; git's has no such limit;
   - `commits.json`: each commit's hash and message;
   - `threads.json` and `comments.json`: review threads and conversation comments; a thread is read up to 100 comments and is marked truncated when it reaches that;
   - `issues/`: the title, body, and state of each GitHub issue the pull request closes, and of each `#n` its title, body, and commit messages reference; a referenced pull request is marked as one;
   - `links.json`: every other ticket or document link in the title, body, and commit messages (a Jira key, a Notion or Asana URL), with the tracker it belongs to when it is recognized;
   - `checks.json`: the check runs on the head commit and their conclusions;
   - `reader.json`: for each changed path, the number of commits on it by the account `gh` is logged in as, read from the GitHub API; for a pull request that changes more than 100 files, only the 100 with the most changed lines are counted;
   - `head/`: the tree of the head commit, from the given clone or a fresh shallow fetch from the host `gh` uses (`GH_HOST`, `github.com` by default), with every committed file and without any `.git` entry or any symlink;
   - `symlinks.json`: each symlink of the head tree, with its target. The symlinks are removed from `head/`, so a tool that walks it cannot follow one out of the prepared directory.

   The script prints one JSON line: the directory's path, the file and line counts, the trackers of the links it found, and nothing from the pull request's text.

   When the head commit cannot be fetched (a private repository the fetch cannot reach), the session suggests running `prepare` again with `--checkout` and a local clone, which works for any host. `prepare` deletes prepared directories older than 30 days.

   When a tracker has no tool on the reader's list, the session makes the list now (see Tickets outside GitHub), still without reading the pull request. Then it runs `explain-pr.js start <dir>`, which turns the mode on for the current session. Turning the mode on is the only thing `start` can do, so text in the pull request gains nothing by calling it.
2. **Read.** The session first checks that the mode is enforced (see below), then reads the prepared directory, reads the linked tickets through the reader's tracker tools (see Tickets outside GitHub), and writes the guide.
3. **End.** The mode has no command that ends it. It ends only by an act of the reader: `/clear`, which gives the session a new id and drops the pull request's text from its context, or a new session. A session that has read the pull request keeps no way to act, because any command the mode allowed for leaving it could be called by text in the pull request as easily as by the reader. Under Claude Code, resuming the same session (`--resume` with its id) resumes the mode, so mode files are never deleted. A fork is a different matter (see Limits): the skill tells the reader not to fork or resume a reading session in order to act.

### Read-only mode under Claude Code

A `PreToolUse` hook with matcher `*` checks every tool call, and stays silent for any session without a mode file.

- **Which session.** `start` writes a mode file named by `CLAUDE_CODE_SESSION_ID`, which equals the `session_id` the hook receives. The file holds the prepared directory's real path. `review-until-approve` writes mode files in the same place for its agents, each a `claude -p` process with a session id of its own. Such a file also names the one file the agent may write and a canary path: the hook denies every call until it has denied and logged a read of the canary path, then explicitly allows reads inside the directory and that write, allows no tool on the reader's list, and logs each decision (see [review-until-approve.md](review-until-approve.md)).
- **What is allowed.** In a session with a mode file, a call is allowed only when it is `Read`, `Glob`, or `Grep` with every path-like input (`file_path`, `path`, `Glob`'s `pattern`, `Grep`'s `path` and `glob`) inside the prepared directory after resolving links, with no absolute or `..` pattern; a tracker tool on the reader's list whose name starts with `mcp__` (see Tickets outside GitHub); or `ToolSearch`, which only returns tool definitions and is how a deferred tracker tool becomes callable. Every other call is denied, with a reason that names the mode and says that `/clear` or a new session ends it. Once a mode file is found, any error denies: a mode file that is empty or cannot be read, or a prepared directory that no longer exists, denies every call.
- **Subagents.** A call that carries an `agent_id` belongs to a subagent of the session and is checked like any other, so a subagent started before the mode, or one that runs the skill itself, is confined with its session. The mode denies the `Agent` and `SendMessage` tools, so the session cannot start or steer one while it reads.
- **Checking it holds.** The mode depends on things the skill cannot see: hooks being on, `node` on the hook's path, and the hook and the shell agreeing on the data directory. Right after `start`, the session makes one call the mode must deny (a shell `true`) and reads the pull request only if the denial names the mode; otherwise it tells the reader the mode is not enforced and stops.
- **Carried context.** The plugin's `Stop` hook harvests tagged lines (decisions, open loops, next steps) into the project state that later sessions are given at start. For a session with a mode file it records how far it has read and harvests nothing, and the start-time catch-up skips such sessions, so text from a pull request never reaches another session. Under Codex the plugin's state hooks need no such rule: they key the state to the session's working directory, which for a reading session is the prepared directory, so no other session receives it.
- **Strength.** A `PreToolUse` deny holds in every permission mode, including the one that skips permission prompts.

### Read-only mode under Codex

Codex's `PreToolUse` hook sees shell commands, patches, and MCP and local function tools, but not hosted tools such as web search, and its input names no agent; its documentation calls it not a complete enforcement boundary. Under Codex the boundary is therefore the sandbox, and the hook is a second line:

- The session that prepares is the user's ordinary session, and it turns no mode on. Under Codex (detected by `CODEX_THREAD_ID`, which Codex sets for every command it runs, even when a `CLAUDE_CODE_SESSION_ID` is inherited from the shell that started it), `start` prints the command that starts a new reading session, and the user starts it; nothing from the pull request is read in the preparing session. The command gives Codex:
  - a permissions profile, defined on the command line, that allows reads only in the prepared directory and the minimal system paths commands need, denies `/tmp` and `/var/tmp` (which the minimal paths leave readable and writable), allows no writes, and allows no network for commands. An agent the session starts with Codex's agent collaboration tools runs under the same profile; this is verified with `codex exec` on macOS, and Limits lists what is not. It is a permissions profile and not `--sandbox`, because `--sandbox` selects the older sandbox, which cannot limit reads to one directory;
  - no approval prompts, so the session cannot ask the user to run a command outside the profile;
  - web search off, and the ChatGPT apps connector off, since it brings a web search tool of its own; browser use, computer use, image generation, and multi-agent off;
  - only the core environment variables (such as `HOME` and `PATH`) passed to commands, so no token in the user's environment is readable;
  - every MCP server defined by an `[mcp_servers.<id>]` table in the user's `config.toml` switched off, except those that host a listed tool. Only the table headers are read, never values, and a header-shaped line inside a multi-line string is not taken as one. Servers defined in another form (an `[mcp_servers]` table, a dotted or inline `mcp_servers` key) are reported as one unparsed form, and are not switched off;
  - advance approval for each listed tool of an MCP server (`mcp__<server>__<tool>`). A server id may itself contain `__`, so a tool belongs to the longest configured server id it starts with, or, when none matches, to the part before the first `__`. Without it, a session that asks for no approval refuses the call. A listed tool named any other way gets no approval; `start` reports it, and it does not run in the reading session;
  - the prepared directory as its working directory, and a prompt that names the skill as `$concord:explain-pr`. Naming it makes Codex load the skill's instructions into the session itself; the profile does not let the session read the plugin's files.
- **Which session.** A Codex session is a reading session when its working directory lies inside the plugin's directory of prepared pull requests. The hook needs no session id, and the user's other sessions, whose working directories lie elsewhere, are unaffected.
- **What is denied.** In a reading session the hook denies patches, local function tools, and every MCP tool not on the reader's list. Shell commands are left to the permissions profile, which confines reads to the prepared directory, so nothing the session can read outside the pull request reaches a tracker tool's arguments. MCP tools that are not listed get no advance approval, so the session refuses them even without the hook, unless the user's own configuration approves them in advance; the servers the launch command switches off offer no tools at all. The launch command's profile and switches are the boundary; the hook is the second line for the cases they miss.
- **Checking it holds.** Before it reads, the reading session lists the user's home directory, which the profile must refuse. If the listing succeeds, the profile is not in effect, and the session tells the reader and stops.
- **Hook trust.** Codex runs a plugin's hook only after the user has trusted it in `/hooks`. Until then the reading session runs with the launch command's switches alone, and the skill asks the user to trust the hook once.
- **Tracker tools.** Only tools of an MCP server work in a reading session. Tracker tools served through ChatGPT apps are switched off with the apps connector.

### Tickets outside GitHub

Intent compares the pull request with its ticket, and Decisions cites tickets, wherever they are kept: Jira, Notion, Asana, or another tracker. A script cannot reach the connectors the reader's harness uses, so tickets outside GitHub are read in the mode, through tools the reader lists.

- **The list.** A per-user file in the plugin's data directory names the tools the mode allows besides reading the prepared directory, by exact name, for example a Jira issue lookup or a Notion page fetch. Only MCP tools (`mcp__<server>__<tool>`) can be listed; any other name in the file is ignored. Only tools that read belong on it; the mode does not check what a listed tool does.
- **Making the list.** When `links.json` names a tracker and no listed tool covers it, the session, before the mode is on, names the read tools of that tracker that the harness offers and asks the reader once which to allow, then writes the file. The session reads no pull request text while it does this; the tracker's name comes from `prepare`'s output.
- **Why this is safe enough.** In the mode the session can read nothing new but the pull request and what the listed tools return, so what it can put in a listed tool's arguments is the pull request's text, what other listed tools returned, and what was already in the session's context before the mode began. A listed tool that only reads cannot change anything with it; one that sends its arguments somewhere the pull request's author can see could carry that context out, which is why only read tools of the reader's own trackers belong on the list.
- **When a ticket cannot be read.** No listed tool, an access error, or a link to an unknown tracker: Intent says which ticket could not be read, and the scope check becomes a question for the author.

## Approaches considered

- **Instructions only.** The session reads the pull request directly, and the skill tells it to treat the text as data and run nothing. It is the simplest and the most conversational, and it is the same on both harnesses. Rejected because nothing enforces it: under a permission mode that asks nothing, an instruction in the pull request that the session follows acts with the user's credentials. `review-until-approve` rejects the same arrangement for the same reason.
- **A confined agent writes the guide to a file.** An agent with only `Read`, `Glob`, `Grep`, and `Write`, like the agents of `review-until-approve`, writes the guide, and the session gives the reader the path without reading it. It is the strongest separation. Rejected because the value of the skill is the conversation over the core hunks: every follow-up question would start a new agent, and the reader would read the guide outside the conversation.
- **Read-only mode (chosen).** The session itself is confined while it reads, so the reader keeps the conversation and the confinement is enforced by the harness, not by the model's compliance. It costs a hook, a mode file, and a session that cannot act again once it has read the pull request; under Codex it costs a second session.

## Limits

- A tool on the reader's list that writes is not stopped. The list is the reader's statement that each tool only reads.
- The guide stays in the session that read the pull request. A view the reader forms there and wants to give `review-until-approve` is given by the reader as notes in a new session, not carried over by the session.
- Under Codex, the permissions profile denies `/tmp` and `/var/tmp`. A data directory placed under `/tmp` (through `EXPLAIN_PR_DIR`) cannot be read by a reading session, since the deny outweighs the prepared directory's read. Another temporary directory is confined only as far as the minimal system paths leave it out.
- Under Codex, an untrusted hook is skipped. The launch command switches off only the MCP servers defined by `[mcp_servers.<id>]` tables in the user's `config.toml`. It does not switch off servers a plugin provides, servers in a system or managed configuration, servers defined in another form (reported as an unparsed form), or servers whose id is not a bare TOML key (reported by id). A tool of such a server that the user's configuration approves in advance runs in the reading session whether or not it is listed.
- Under Codex, switching multi-agent off leaves the agent collaboration tools (spawning and messaging an agent) in the reading session. An agent they start keeps the session's permissions profile under `codex exec` on macOS; that it does in an interactive session or on Linux, and whether Codex's `PreToolUse` hook sees those tools, is not verified.
- Under Claude Code, when the data directory's `modes` path exists but cannot be read (it is a file, or permissions refuse it), every session that uses that data directory counts as in the mode: the read-only hook denies every tool call, and the `Stop` hook harvests no tagged lines, without saying so. Both fail closed until the path is repaired.
- Under Claude Code, forking a reading session (`/branch`, `--fork-session`) gives a new session id with the same context and without the mode. Under Codex, `codex resume` restores a reading session's conversation without the launch command's switches. Either way the pull request's text is back in a session that can act. The skill tells the reader not to do this; nothing prevents it.
- The launch command relies on a permissions profile selected on the command line taking effect. Codex's documentation says that a `sandbox_mode` in a loaded configuration file overrides it; in that case the reading session starts without read confinement.
- A mod or harness extension that can approve a call a hook denied overrides the mode under Claude Code. The mode protects against the pull request, not against the user's own configuration.
- The mode does not stop the explanation from being wrong. Anchors make a wrong claim checkable; they do not make it right.
- Evidence that a test fails without the change comes only from what CI or the pull request records. The skill runs no test.
- A reader who has never committed to the changed paths but knows them well gets the background first until they say otherwise.

## Relation to other skills

- `review-until-approve` judges and approves. A reader can run `explain-pr` first, form their own view, and give that view to `review-until-approve` as notes, which its design describes.
- The read-only hook is a general module of the plugin's hooks: given a session's mode file, it allows reading inside one directory and denies the rest. `review-until-approve` confines its reviewer and verifier with it, and prepares each round in the same directory of prepared pull requests, so under Codex the same hook treats its agents as reading sessions.
