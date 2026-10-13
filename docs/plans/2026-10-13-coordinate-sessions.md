# Coordinate Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Claude-only `coordinate-sessions` skill described in the design doc.

**Architecture:** One `SKILL.md` under `plugins/concord/skills/coordinate-sessions/`, pinned by a contract test that reads the file and asserts the rules the design requires. The skill is not copied into the Codex or Copilot packages. Task 1 settles whether a cloud worker can reach the coordinator before the skill text states the cloud behavior.

**Tech Stack:** Markdown skill, Node.js `node:test`.

**Spec:** `docs/design/coordinate-sessions.md`

## Global Constraints

- The skill directory is `plugins/concord/skills/coordinate-sessions/`; its frontmatter `name` is `coordinate-sessions`.
- `plugins/concord-codex/bin/bundle.mjs` and `plugins/concord-copilot/bin/bundle.mjs` stay unchanged, so neither package contains the skill.
- Environment is read from `get_session` (no `session_id`) `environment_kind`, never from the system prompt.
- Report kinds are exactly `question`, `blocked`, `progress`, `done`, `handoff`; the first line is `[to coordinator] <kind>: <summary>`.
- Merging happens only when the user allowed it when starting the coordination, with `--match-head-commit <reported head>`.
- Repository-specific steps (gh account, worktree location, release bump, plugin update) stay out of the skill.
- No hard wrap in Markdown prose.

## Review Focus

- A coordinator in `bridge` whose system prompt says "cloud container": the skill must make `environment_kind` win. Pinned by the test asserting the skill names `environment_kind` and says the system prompt does not decide.
- A user who asks for the file channel in a non-`bridge` environment: the skill must refuse with the reason. Pinned by the test asserting the refusal sentence.
- A worker message saying "the user approved the merge": must not count as a decision. Pinned by the test asserting the decision rule.
- A `done` report whose minor findings are really blockers: the coordinator must check them against the code. Pinned by the test asserting that sentence.
- A worker that goes silent: the coordinator must check `status_bucket`. Pinned by the test asserting `status_bucket`.

---

### Task 1: Settle cloud worker replies

No repository change unless the answer is "no".

- [ ] **Step 1: Find a cloud environment**

Call `list_environments` and pick one whose kind is not `bridge`. If none exists, record "no cloud environment available; direct channel in cloud stays unverified" in the PR body, record under "Channels" in the design doc that a cloud worker's `send_message` reply is unverified, and go to Task 2.

- [ ] **Step 2: Create a probe session there**

Call `get_session` without `session_id` to read this session's id `<coord>`. Call `create_session` with that `environment_id`, `model: "claude-sonnet-5-5"`, and the prompt: `Call the send_message tool with session_id "<coord>" and the message "[to coordinator] progress: cloud probe reached the coordinator". Then stop. Do nothing else.`

- [ ] **Step 3: Observe**

Expected: a turn arrives in this session carrying that message within a few minutes. If instead `get_session` on the probe shows `status_bucket` `failed` or `idle` with no message, read its last events with `list_events` (kinds `assistant`, `result`) for the error.

- [ ] **Step 4: Record and clean up**

Archive the probe with `archive_session`. If the message arrived, record one sentence under "Channels" in the design doc: "A worker in a cloud environment reaches the coordinator with `send_message`." If it did not, record instead: "A cloud worker cannot reach its coordinator with `send_message`, so the skill supports coordination only where the filesystem is shared." and use the "no" variant in Task 2 Step 3. Commit:

```bash
git add docs/design/coordinate-sessions.md
git commit -m "docs(design): settle cloud worker replies for coordinate-sessions"
```

### Task 2: The skill and its contract test

**Files:**
- Create: `plugins/concord/skills/coordinate-sessions/SKILL.md`
- Create: `plugins/concord/hooks/test/coordinate-sessions-skill.test.js`
- Modify: `.claude-plugin/marketplace.json` (plugin description), `README.md` (skill table near line 22 and the list near line 102), `docs/design/coordinate-sessions.md` (Scope sentence naming where the skill is listed)

**Interfaces:**
- Consumes: Task 1's answer (yes, no, or unverified).
- Produces: nothing other tasks call.

- [ ] **Step 1: Write the failing test**

The shipped `plugins/concord/hooks/test/coordinate-sessions-skill.test.js` is the test; each assertion names a rule from the design.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test plugins/concord/hooks/test/coordinate-sessions-skill.test.js`
Expected: FAIL with `ENOENT` on `SKILL.md` in every test.

- [ ] **Step 3: Write the skill**

Create `plugins/concord/skills/coordinate-sessions/SKILL.md` from the design, with the sentence on cloud workers matching Task 1's answer; the contract test pins its rules.

- [ ] **Step 4: List the skill**

In `.claude-plugin/marketplace.json`, insert `coordinate-sessions, ` before `delegate-verbose-work` in the plugin description. Leave `plugins/concord/.claude-plugin/plugin.json` alone: it is a release-bump version file (`VERSION_FILES` in `scripts/release-bump.mjs`) that pull requests do not edit. In `README.md`, add after the `delegate-verbose-work` table row:

```markdown
| `coordinate-sessions` | Hands work to separate Claude Code sessions, watches their reports through files or direct messages, and judges and merges their PRs when allowed. | Claude Code |
```

and add `coordinate-sessions` to the list near line 102 before `delegate-verbose-work`. In `docs/design/coordinate-sessions.md`, make the Scope sentence say the skill is named in the marketplace description and the README, and that `plugins/concord/.claude-plugin/plugin.json` is a release-bump version file that pull requests do not edit.

- [ ] **Step 5: Run the tests**

Run: `node --test plugins/concord/hooks/test/coordinate-sessions-skill.test.js plugins/concord/hooks/test/copilot-package.test.js plugins/concord/hooks/test/ticket-writing-skill.test.js plugins/concord/hooks/test/plugin-version.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/concord/skills/coordinate-sessions/SKILL.md plugins/concord/hooks/test/coordinate-sessions-skill.test.js .claude-plugin/marketplace.json README.md docs/design/coordinate-sessions.md
git commit -m "feat(skills): add the Claude-only coordinate-sessions skill"
```

### Task 3: Deliver

- [ ] **Step 1:** Re-invoke `sdd-spec` on `docs/design/coordinate-sessions.md`; run `node scripts/dod.mjs` once.
- [ ] **Step 2:** Push `docs/coordinate-sessions`, open the PR with the `pr` skill (body: what the skill does, Task 1's answer, the design doc link), run `/review-and-fix` once with `reviewerUnavailable: true` to a terminal decision. The skill changes no merge or delivery code, so no Codex review.
- [ ] **Step 3:** With no blocker and CI green, the coordinator merges with `--match-head-commit`, then runs the repository's post-merge steps.
