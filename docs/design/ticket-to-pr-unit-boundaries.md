# Implementation unit boundaries

The default implementation unit is one coherent approved ticket outcome. Its atomic acceptance behavior stays together; implementation layers, task count and file count alone do not justify separate PRs. A multi-repository outcome has one implementation unit per repository with a shared outcome-level contract and integration check.

Before implementation, the plan records each unit's outcome, acceptance criteria, repository/base, dependency refs and boundary reason. A separate unit requires a named reason: an independently deployable or revertible boundary, a prerequisite that must merge first, a repository delivery boundary, or an explicit ownership split. Each reason is justified against the approved outcome rather than used as a generic label for fragmentation.

A plan that mixes unrelated outcomes, splits only by frontend/backend layers, or relies on an arbitrary size threshold has no settled boundary. Choosing the boundary changes the scope of a ticket, so it is a product decision: it goes to the user before dependent implementation, and work that does not depend on it continues. A scope change that exceeds an approved boundary is the same kind of decision; it does not silently enlarge a pull request or create unplanned ones.

The completion report maps every PR to its approved unit, dependency and boundary justification. Examples:

| Plan | Disposition |
| --- | --- |
| One endpoint behavior with its UI caller and tests in one repository | Keep the coherent outcome together |
| A prerequisite schema deployment must land before its consumer | Separate units with an explicit dependency and deployment rationale |
| One outcome spans two repositories | Separate repository units under the shared outcome contract |
| Two explicitly assigned owners require separate branches | Record the ownership boundary and integration responsibility |
| Frontend PR and backend PR solely because they are different layers | Ask for the boundary as a product decision unless a supported one is established |
| A PR absorbs a second unrelated outcome during implementation | Report it as a product decision before implementing that outcome |
