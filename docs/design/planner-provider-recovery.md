# Failed planner provider recovery

## Contract and decision

An incomplete protocol-v2 classification permits one semantic replacement in the same unchanged round. Dispatch consumes that allowance even when the provider fails. A positively identified rate limit or transient execution failure may authorize one additional transport launch of that replacement; it never restores the semantic allowance. Authentication, malformed provider responses, unknown exits and parent interruption require terminal handoff. A successful but incomplete transport result exhausts semantic recovery.

The CLI owns `execution.planTransportRetry`: `pending` with zero attempts, `dispatched` with one attempt, or `exhausted`. `planRetry.launched` remains true. After the existing initiative reservation is granted, `plan-dispatch` atomically consumes transport recovery before spawning. A crash after dispatch cannot authorize another process. Every actual failed launch remains charged; neither the run key nor round changes. Reservation denial launches nothing and preserves the budget blocker.

Successful normalization retains a pending plan for acceptance without another process. `execution.planRepairPending` retains the separate representation workflow after a successful planner process needs repair. A successful repair interrupted after its bound candidate is staged may validate that candidate on resume. A failed repair subprocess during replacement or transport recovery terminates planning conservatively, even if it wrote candidate bytes; it never earns another transport launch or restores its one representation attempt.

Resume preserves the exact sealed correctness, verify, intent and gate evidence under the existing scope/hash checks. It launches only plan when those dependencies remain valid. Lost or changed evidence cannot silently turn transport recovery into reviewer replay; reconciliation is required. Existing beta.5 exhausted failures have no diagnostics proving retryability and remain terminal without ledger surgery.

## Diagnostics and continuation

Provider execution failures are classified in memory into `authentication`, `rate-limit`, `transient`, `malformed-response` or `unknown`. Authentication dominates conflicting transient evidence. Recognized structured codes and narrow error indicators provide best-effort classification; ordinary stdout prose cannot authorize a retry. Persist only a canonical fixed message, internally mapped provider/engine/schema, validated numeric exit code and signal. Raw stdout, stderr, exception messages, stacks and arbitrary metadata never cross this diagnostic boundary. The durable CLI boundary canonicalizes diagnostics again.

One shared continuation function governs CLI failure results, resume dispatch, session reports and runner packets. Actionable transport recovery advertises `resume`; exhausted or terminal work advertises `terminal-handoff`. The runner verifies durable failure state before advertising continuation and fails closed when persistence/readback fails. An error disposition alone never authorizes another launch.

Initiative error entries remain audit records with their original budget snapshot and delivery claim. Failure identity includes the bounded round, semantic/transport attempt state and continuation, so identical canonical diagnostics from distinct recovery attempts append distinct dispositions. Recording or redelivering the same occurrence remains idempotent. Neither an earlier outcome nor its consumed delivery claim is overwritten to represent a later failure.

## Alternatives, costs and residual exposure

Restoring `planRetry.launched` would conflate semantic and transport attempts and permit repeated invalid plans. Treating every failure as terminal is bounded but prevents supported recovery from rate limiting. Regex redaction of arbitrary provider output cannot guarantee that opaque credentials are removed. Canonical summaries sacrifice verbatim debugging detail for a reliable persistence boundary. Classification can miss an unrecognized transient error; unknown failures intentionally terminate.

Provider-authored review artifacts and independent provider logs lie outside this diagnostic boundary. The provider can still produce invalid plans, representation failures, or denied budget reservations; all retain existing fail-closed rules. One transport retry is a hard per-round limit, including interrupted dispatched attempts.

## Evidence and executable gates

Baseline: `8408180a3ad2568b76ba5629425d6abd9f0a9353`, Concord beta.5, Node 24.13.0, Linux. `node --test --test-reporter=tap --test-name-pattern='nonzero replacement retains' plugins/concord/hooks/test/planner-provider-recovery.test.js` fails because the replacement exit loses its safe diagnostic. The harness drives the real CLI and fixture provider subprocess seam; it does not establish a live provider outage.

Required checks: outcome recovery regression, adversarial diagnostic tests, focused runner/CLI/initiative/telemetry suites, Codex/Copilot bundle drift and packaging tests, plugin and agent-team CI suites, and `node scripts/dod.mjs`. Design and branch review-and-fix are required gates. Live provider outage reproduction is outside scope; deterministic failures establish the runner contract.

Documentation disposition: correct the artifact contract's two-process limit, incomplete-plan recovery and ledger docs, initiative disposition semantics, and Claude/Codex/Copilot operator guidance. Preserve the historical #213 implementation plan, original routing design, README feature table and telemetry design because they make no conflicting recovery promise.
