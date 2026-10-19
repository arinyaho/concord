# Multi-source reporting

Synthesize plans, observed work, and commitments into a short report for the requested audience and interval.

## Plan, outcome, and next steps

Where connected sources expose plans, reviews, or retrospectives, use the relevant plan as the intended-work frame and check each material outcome against current evidence. Surface planned-versus-done gaps and explicit retrospective actions. A plan proves intent, not delivery. A ticket edited within the reporting interval does not by itself prove that its completion occurred within that interval; retrieve the transition/event evidence or label the timing unknown.

For a report spanning several sprints or milestones, cover the plans/reviews overlapping the requested interval rather than only the most recent sprint. Query adjacent future plans only when next actions are part of the requested report; label future evidence separately from activity in the reporting interval.

An upcoming plan may be an empty scaffold. If so, use an existing review's stated next direction, explicit backlog commitments, and sourced messages or deadlines as available. Record which basis was used. A backlog entry or draft PR is a candidate, not automatically a commitment for the next period. If no plan evidence exists, say so and label recommendations as proposed.

## Signal and deduplication

Organize by project or theme inside each view, not by service. One effort discussed in chat, tracked in an issue, and implemented in a PR is one report item with several evidence links.

When mail is relevant, focus on its unique information: customer delivery, external deadlines, dependencies, decisions, and requests awaiting a response. Skip routine tracker/repository/document notifications already represented by primary records. Do not exclude all notifications blindly: retain unique decisions, approvals, deadlines, or blockers found only in a notification. Use the connected account's actual query syntax and avoid hardcoded senders or company domains.

Compress repetitive maintenance (such as dependency updates) into one sourced line and spend detail on outcomes that change the product or team's next action. Give counts only when the collected evidence supports them, and qualify counts from partial searches. Do not equate a large activity count with impact.

An old open PR or a Bug label alone is not proof of a blocker. Cite the missing dependency, unanswered request, failed check, or decision that actually prevents progress. Separate observed blockers from possible risks. “No blockers found in checked sources” is narrower than “no blockers”; never report the latter when coverage is partial.

## Default presentation

Honor the user's requested structure and language. For an unspecified multi-source report, use:

- A brief overview of the strongest outcome and material risk.
- **Completed outcomes** — what was achieved in the requested period, with evidence.
- **In progress** — current stage and remaining work, with status observation time.
- **Next steps** — sourced plans/commitments or clearly labeled proposals.
- **Blockers and issues** — what is blocked, what it awaits, and the recorded owner/deadline if available.

Adapt headings to the requested language and interval (for example, “달성 / 진행 중 / 다음 단계 / 블로커·이슈”). Do not force weekly headings onto a daily, monthly, milestone, or arbitrary-range report. For a blockers-only request, prioritize that view instead of forcing four full sections.

Place links beside claims. Include a compact source-coverage note; a source-by-source evidence appendix is optional when traceability or requested detail warrants it. Do not append raw responses by default. If saving is requested, use the authorized destination and an interval-appropriate filename, then summarize the main findings and actual saved location in chat. Use a destination appropriate to the actual account and request; there is no default company-specific directory.
