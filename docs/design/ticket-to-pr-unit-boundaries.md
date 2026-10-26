# Implementation unit boundaries

The default implementation unit is one coherent approved ticket outcome. Its atomic acceptance behavior stays together; implementation layers, task count and file count alone do not justify separate PRs. A multi-repository outcome has one implementation unit per repository with a shared outcome-level contract and integration check.

Before implementation, the plan records each unit's outcome, acceptance criteria, repository/base, dependency refs and boundary reason. A separate unit requires a named reason: an independently deployable or revertible boundary, a prerequisite that must merge first, a repository delivery boundary, or an explicit ownership split. Each reason is justified against the approved outcome rather than used as a generic label for fragmentation.

A plan that mixes unrelated outcomes, splits only by frontend/backend layers, or relies on an arbitrary size threshold is `unit-boundary-unsettled` and returns to planning before dependent implementation. A scope change that exceeds an approved boundary also returns to the plan checkpoint; it does not silently enlarge a PR or create unplanned ones. The initiative dependency plan remains sealed after the first reservation. Replanning does not authorize changing that live graph, resetting budgets or replacing run keys outside the applicable reconciliation procedure.

The completion report maps every PR to its approved unit, dependency and boundary justification. Examples:

| Plan | Disposition |
| --- | --- |
| One endpoint behavior with its UI caller and tests in one repository | Keep the coherent outcome together |
| A prerequisite schema deployment must land before its consumer | Separate units with an explicit dependency and deployment rationale |
| One outcome spans two repositories | Separate repository units under the shared outcome contract |
| Two explicitly assigned owners require separate branches | Record the ownership boundary and integration responsibility |
| Frontend PR and backend PR solely because they are different layers | Return to planning unless a supported boundary is established |
| A PR absorbs a second unrelated outcome during implementation | Return to the plan checkpoint before implementing that outcome |
