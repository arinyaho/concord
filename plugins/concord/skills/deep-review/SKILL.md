---
name: deep-review
description: Run one bounded holistic review of a fixed base/head revision pair using independent reviewers, pooled finding verification, and root-cause grouping. Use only when the user explicitly asks for deep-review after ordinary review; it is not a release gate and never loops until green.
---

# Deep Review

Treat the supplied base and head as immutable. If either changes, stop and report that the evidence is stale; do not restart automatically.

Run exactly one pass with at most six reviewer launches:

1. Launch three independent finders in clean contexts and in parallel. Give each the same diff, repository access, and applicable design/acceptance criteria. Assign complementary emphasis: correctness plus efficiency; design/AC plus silent gaps; cross-context plus threat modeling. Each reports evidence-backed findings only.
2. Pool and deduplicate every candidate by root cause and evidence, without dismissing disagreement.
3. Launch three independent validators in clean contexts and in parallel. Give every validator the complete pooled set, not one finding at a time. Each returns a verdict and reason for every candidate and may identify relationships or conflicts among candidates.
4. Keep a candidate only when at least two validators confirm it. Preserve dissent in the report. Group surviving findings that share a root cause or require a coordinated change.
5. Return one report containing the immutable revision pair, examined scope, rejected candidates with reasons, surviving groups, and a single implementation plan per group.

Do not run another pass, retry a clean result, invoke review-and-fix, run a convergence panel, modify code, or create/update a PR unless the user separately asks. A blocked or missing reviewer is missing evidence, not a negative vote. Report the incomplete check and continue only with the evidence that actually ran.

If implementation is separately authorized, apply one coherent fix per group and validate only the affected diff plus the repository's required checks. Do not reopen the holistic pass automatically.
