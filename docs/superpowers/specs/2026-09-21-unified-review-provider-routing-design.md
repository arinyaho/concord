# Unified review provider routing design

## Goal

Concord exposes one `review-until-green` workflow whose reviewer and fixer providers and models are selected independently at invocation time. Claude Code, Codex, and GitHub Copilot packages expose the same plugin name and review interface.

## Invocation contract

The workflow accepts `--reviewer <claude|codex|copilot>`, `--reviewer-model <model>`, `--fixer <claude|codex|copilot>`, and `--fixer-model <model>`. An omitted provider defaults to the active host. An omitted model uses that provider's configured default. A requested model is passed unchanged, and an unavailable executable, authentication, provider, model, or required tool fails the run before the first source mutation. Concord never silently substitutes another provider or model.

`--reviewer` applies to correctness, verify, intent, gate, panel-lens, and panel-vote roles. `--fixer` applies only to planned fix roles. The driver, deterministic CLI, artifact contracts, sequencing, commit discipline, and termination rules remain provider-neutral.

## Dispatch

Each package declares its active host. When a role selects the active host and the host supports a clean-context native subagent with explicit model selection, Concord uses that native mechanism. Otherwise Concord starts a clean non-interactive process through the selected provider CLI.

| Provider | CLI execution | Model argument |
|---|---|---|
| Claude | `claude -p` | `--model` |
| Codex | `codex exec` | `--model` |
| Copilot | `copilot -p` | `--model` |

All nine reviewer/fixer provider combinations are valid on every host when the required native facility or CLI is available. Native and CLI adapters receive the same bounded prompt and artifact destination. Review roles may only inspect and write their JSON artifact. Fix roles may edit the repository and write their JSON artifact. Independent review roles retain the driver's existing parallelism; fix roles remain sequential.

## Artifact and failure boundary

The provider process must either write the requested artifact directly or return structured JSON that the host adapter writes verbatim. Concord validates the artifact through the existing normalization and planning contracts before advancing. A non-zero process exit, missing executable, unavailable requested model, missing artifact, denied required operation, or declared `blocked` result is a harness failure. No adapter may reinterpret prose as a clean verdict or fall back to the active model.

## State and telemetry

The run ledger records reviewer provider, reviewer model, fixer provider, and fixer model so resume preserves the original routing. Every invocation records its actual provider and requested model when authenticated telemetry exists. Native mechanisms that do not expose stable usage evidence remain explicitly partial; they do not receive synthetic token counts.

## Packaging

Claude Code, Codex, and GitHub Copilot marketplace entries and manifests use the plugin name `concord`. The provider-specific distribution directories remain implementation details. `concord-codex-review` and `cross-model-review` are removed because provider and model routing belongs to `review-until-green`. `review-until-lgtm` remains separate because it observes an external GitHub review outcome and neither reviews nor fixes the target itself.

## Verification

Tests cover argument parsing, role-specific routing and model forwarding, native preference, CLI fallback for every provider, fail-closed provider errors, routing persistence across resume, package name parity, removal of duplicate skills, generated bundle parity, and the existing review convergence behavior.