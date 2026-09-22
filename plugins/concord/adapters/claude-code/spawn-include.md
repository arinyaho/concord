<!-- plugins/concord/adapters/claude-code/spawn-include.md -->
**Provider routing.** Parse `--reviewer <claude|codex|copilot>`, `--reviewer-model <model>`, `--fixer <claude|codex|copilot>`, and `--fixer-model <model>` from the invocation. Providers default to `claude`; models default to the selected provider's configured model. Use the reviewer selection for every review-class role and the fixer selection only for step 5. Carry the same selections through every round and resume. Reject missing values and unknown providers before `round-start`; never substitute another provider or model.

For a Claude role, use the native `Task` tool with the `general-purpose` agent in a CLEAN context and pass the requested model explicitly when one was supplied. For a non-Claude role, start a clean non-interactive CLI process in the repository root:

- Codex: `codex exec --cd <repoRoot> --sandbox workspace-write --add-dir <stateDir> --skip-git-repo-check [--model <model>] "<prompt>"`
- Copilot: `copilot -C <repoRoot> -p "<prompt>" --silent --allow-all-tools --allow-all-paths --no-ask-user [--model <model>]`

The external CLI must write the requested artifact itself. Redirect its output away from the parent context and treat a missing executable, authentication/model failure, non-zero exit, missing artifact, or blocked operation as a harness failure. Parallel spawns run concurrently only where the driver permits it; sequential dependencies wait for the prior artifact. Allocate `telemetry-slot --engine claude-code` only for native Claude roles because external CLI evidence is not authenticated by Claude's agent hooks.
