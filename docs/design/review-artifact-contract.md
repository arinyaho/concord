# Review artifact contract

Every reviewer role in a round of `review-until-approve` writes one JSON artifact, and the runner under `plugins/concord/skills/review-until-approve/scripts/runner/` normalizes it before anything reads it. This document covers the role registry and ID namespaces, what the runner trusts in an artifact and how it reads one, how a representation failure is repaired without rerunning the reviewer, and when a correctness artifact covers the change. The order of the roles and the fold of their findings are described in the [review-until-approve design](review-until-approve.md).

## Roles and namespaces

`artifact-contract.js` is the only registry of artifact shapes and owned ID prefixes. Prompt generation (`round-plan.js`) and validation both read it, so the namespace a prompt states cannot drift from the one validation enforces.

| Artifact role | Required array fields in the normalized shape | Owned ID prefixes |
| --- | --- | --- |
| `correctness` | `examined`, `findings` | `correctness:`, `docreview:` |
| `verify` | `rejected`, `findings` | `correctness:`, `docreview:` |
| `intent` | `findings` | `intent:` |
| `gate` | `findings` | `gate:` |
| `gate-verify` | `rejected`, `findings` | `gate:` |

Strict normalization rejects IDs outside a role's prefixes, malformed JSON, structurally incomplete findings, and declared blocked checks. It never silently filters cross-namespace entries to make an artifact pass. A normalization failure that the repair below does not cover fails the round.

### Unverifiable candidates

`verify` and `gate-verify` accept an optional `unverifiable` array of `{"id","reason"}` entries. The id uses the role's prefixes, the reason names the probe that ran and the environment property that decided its result, and an id never appears in both `rejected` and `unverifiable`. An invalid entry makes the artifact invalid; a non-array field is fatal.

The Codex reviewer sandbox is a user namespace, so a host owner it cannot map, root included, appears as uid 65534. A probe that checks ownership therefore fails there although the code passes on the host. The verifier lists such a candidate in `unverifiable` instead of declaring `blocked`. An `unverifiable` entry is not a rejection: the candidate survives the fold like any finding the verifier did not refute, so the field can keep a finding but never remove one.

`blocked` stays fatal for a tool that is missing, denied, crashed or timed out. Every role that can run a probe is told about the user namespace: `verify` and `gate-verify` get the `unverifiable` rule above, and `correctness` and `gate` are told that a sandbox-decided probe is not a failed method and to raise the gap as a normal finding naming the probe, which the verifier then re-checks. The finder artifacts have no `unverifiable` field, because a detector has nothing to refute. `intent` runs no probe and gets no note. The sandbox is not relaxed.

### Gate verifier context

When the gate pair runs, `gate-verify` reads the complete correctness candidate set, because cross-panel context lets it identify duplicate, related, or conflicting observations. That context does not transfer disposition ownership: `correctness` and `verify` own `correctness:*` and `docreview:*` candidates, while `gate` and `gate-verify` own `gate:*` candidates. The `gate-verify` prompt states that correctness candidates are context only, that verdicts are written only for `gate:*` candidates, and that `correctness:*` IDs are never copied, accepted, or rejected. It builds that clause from the registry's prefix accessor rather than from its own namespace literals. A `gate:` candidate that restates a correctness candidate is listed in `duplicates`, not `rejected`, and drops out only while that correctness candidate survives its own verifier.

## Reading untrusted artifacts

The reviewed checkout is untrusted and the round's state directory is the reviewer's artifact channel, so the runner treats every artifact as untrusted input.

- **Bounded reads.** Artifacts are hashed and read through one bounded reader (`bounded-artifact.js`). It rejects symlinks and nonregular files, opens descriptors without following the final link and without waiting on FIFOs, and verifies that the opened file agrees with path metadata. Reads stop at 20 MiB; hashes consume bounded chunks without loading the entire file. A future artifact may be absent, while an entry that changes during opening or reading is a failure. Accepted artifacts are published with exclusive creation and atomic replacement, so a planted temporary symlink cannot redirect a trusted write.
- **Seals.** The diff, the intent file and every accepted artifact are sealed by hash. Before and after each launch the runner checks every seal, allowing only the one file the launched role is asked to write.
- **Checkout inventory.** The runner inventories the tracked checkout before the first reviewer starts and compares it after every reviewer and before findings are returned. Paths come from the reviewed commit's tree, not the index, so assume-unchanged and skip-worktree flags cannot hide an entry. Each path records its file type and mode, the SHA-256 of regular-file bytes read through the bounded reader, a symlink's target without following it, absence, and an initialized submodule's commit and own inventory. The comparison is against the checkout's own earlier state, so checkout filters and line-ending conversion never run. A path that escapes the checkout, a tracked file over 20 MiB, or an inventory over 250,000 entries or 4 GiB fails the round. The visible dirty and `HEAD` checks also apply.
- **Scope.** The patch and the changed-path list come from the same fixed comparison endpoints. The path list uses NUL-delimited Git output with rename detection disabled, so both rename paths, deletions, binary changes, empty additions and mode-only changes take part in correctness coverage. The runner keeps that list in memory, where no role can reach it, so an untrusted role cannot narrow the set it must examine.

This bounds resource use and checks file identity at the read boundary. It does not provide an operating-system sandbox or an atomic directory-tree snapshot, and the inventory does not cover untracked, ignored or generated files.

## Artifact repair

A representation failure in an artifact is handled by at most one repair that the runner builds without a model, never by rerunning the substantive reviewer. Repair can restate evidence already present; it cannot perform review or supply missing evidence. A repair that cannot be shown to preserve the original fails the round.

### Eligibility

Only four failures are eligible: a status spelling that differs from an accepted value only by case, an ID whose prefix is the role's own but whose slug breaks the ID rule, a mixed-namespace artifact that contains both role-owned and foreign IDs, and, in `verify` and `gate-verify`, a `findings` entry that lacks `id`, `file` or `summary` (a kept candidate written in a verdict shape). Every other schema-validation failure, including malformed JSON, structurally incomplete findings in the other roles, declared blocked checks, a bare rejection ID without a reason, and a missing artifact, fails the round.

### Candidate

The candidate is built from the artifact alone (`repairCandidate`): no diff text, repository files, intent, other artifacts or prompt. The status is lowercased, every item the role does not own is omitted (in `rejected`, `findings` and `unverifiable`), every evidence-less `findings` entry is deleted, and every invalid slug is rewritten. A slug is rewritten by lowercasing it, turning each run of characters outside `a-z0-9` into `-`, trimming `-` from both ends and cutting each segment to 80 characters (`gate:<class>:<slug>` rewrites both segments), applied to the same ID wherever the artifact names it (`findings`, `rejected`, `unverifiable`, `blocking`, `duplicates`, `addressed`). An ID that is already valid is never rewritten. The rewrite is not made when a segment becomes empty or two different IDs would become one, and the failure stands. No model is involved, so the repair is the same for every reviewer provider and needs no isolation boundary.

### Acceptance

The candidate is accepted only when it passes strict validation and a separate preservation check against the original (`preservesArtifact`). The check compares every field of the original other than `status` with the candidate structurally, so role-owned findings, rejections with their reasons, examined coverage and classifications must be unchanged, and the candidate may not add a field the original lacks. The only permitted differences are the status spelling, the slug rewrite above and the omission of foreign dispositions, and that omission is allowed only when the role-owned evidence that remains is exactly the original's role-owned evidence. A correctness-only `gate-verify` artifact contains no gate verdict, so neither relabeling `correctness:` to `gate:` nor emitting empty `rejected` and `findings` arrays is a valid repair. The prefix of an ID is never rewritten or transferred between owners.

### Rationale

Rerunning a reviewer with an appended correction prompt sends the full review context again and lets a schema-valid retry drop evidence the original contained, so normalization would not guarantee that the original evidence survives. Repair trades some automatic recovery for trustworthy evidence. Each permitted change is mechanical and the preservation check accepts exactly one candidate, so a model would add only cost, a crash window and an isolation requirement. The cost is that the builder and the check share one rule.

## Correctness coverage

The `correctness` artifact must list every changed path in `examined`. A changed path counts as examined when it is listed, or when its blob at the reviewed head equals the blob of a listed changed path: two files with identical bytes have the same content, so the review of one is the review of the other, which also covers generated copies such as the Codex package. The old path of a rename detected between the round's base and head (`git diff -M`) counts as examined when `examined` lists the new path. A deleted path has no blob and must be listed by name.

Only the reviewer can say it read a file, so a correctness artifact that leaves out changed paths gets one re-run whose prompt names them; a second miss fails the round. A role gets one correction in a round, either the repair or the re-run: a repaired correctness artifact that leaves out a path fails the round without a re-run, and the artifact of a re-run is not repaired.

## Rounds with no finder candidates

When `correctness` and, on a broad round, `gate` both sealed an artifact with no findings, `verify` has no candidate to rule on and does not run. `gate-verify` still runs on a broad round, because it can add `gate:` findings. Skipping `verify` loses its second look, including correctness candidates the finder missed; for a round whose finders reported nothing, the review accepts that loss in exchange for the launch it saves. Such a round returns no `addressed` verdict.

## Residual exposure

- A reviewer can still emit false but schema-valid evidence; preservation proves continuity, not truth.
- The candidate builder and the preservation check encode the same rule, so a mistake in that rule passes both; the tests pin each eligible case and the refused ones.
- The structural preservation comparison rejects harmless rewrites, and schema-validation failures outside the eligible kinds fail the round even when a reviewer rerun might have produced a usable artifact.
- The state directory is writable by the reviewer. The runner pins and hashes the files it later trusts, so a later role cannot change them unnoticed, but the directory is not read-only.
