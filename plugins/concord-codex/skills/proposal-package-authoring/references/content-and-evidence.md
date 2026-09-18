# Content and evidence

## Source hierarchy

Use sources in this order when they conflict:

1. RFP, official Q&A, and confirmed customer agreements
2. Requirement and compliance tracking documents
3. Verified product evidence, benchmark results, and architecture documentation
4. Existing proposal materials and reference decks
5. Stakeholder feedback and aesthetic preferences

Never turn an unsupported aspiration into a committed fact. Preserve unresolved items as explicit open loops.

## Establish the contract

- Identify deliverable format, aspect ratio or paper size, page limits, required sections, evaluation criteria, submission constraints, presentation time, and output-size limit.
- Record confirmed deviations from the written RFP, including test environment and measurement method.
- Resolve which file is canonical before editing when multiple copies exist.
- Separate requirement satisfaction from implementation scope. “충족” states whether the requirement is met; “구축 범위” states what will be delivered to meet it.
- A final proposal must not retain `미충족` or `부분충족`. Close the gap, narrow the claim to a demonstrably satisfied interpretation, or escalate the unresolved requirement before finalization.
- Avoid vague future-tense claims such as “제공 가능” when the evaluator may interpret them as unavailable. State committed scope and evidence.

## Paired deck manifest

For new decks and full revisions, create one `deck.md` before visual production unless the project already has an equivalent structured source. Do not create one Markdown file per slide.

- Treat `deck.md` as the source of truth for narrative, claims, on-slide copy, evidence, customer value, requirement links, visual intent, speaker notes, and synchronization status.
- Treat the native Slides or PowerPoint file as the source of truth for composition, coordinates, typography, image crops, diagrams, and animation.
- Identify slides with a stable slide object ID and a human-readable sequence label. Do not rely on page numbers alone.
- For each slide, record only fields that affect decisions: evaluator question, title, takeaway, on-slide copy, evidence, customer value, visual brief, requirement IDs, transition, and status.
- Use a small status vocabulary such as `draft`, `needs-evidence`, `needs-design`, and `synced`.
- Make structural, factual, and wording changes in `deck.md` first, then apply them to the deck. Purely visual adjustments may start in the deck.
- Do not encode coordinates, CSS, or complete rendering instructions in Markdown.
- Do not retroactively build a manifest during a small incremental revision unless requested or its absence is causing material drift.

After a content revision, compare the changed slide with its manifest entry and mark it `synced` only when slide, notes, evidence, and requirement links agree.

## Build the evaluator story

For every substantive slide, define:

- the evaluator question it answers;
- the single takeaway;
- the evidence that makes the takeaway credible;
- the value or reduced risk delivered to the customer.

Do not spend a prominent callout on facts with no decision value. Pair a necessary technical fact or test condition with the customer value it enables.

Prefer compact noun-phrase titles over sentence-form titles. Put the full claim in body copy, subtitles, or callouts.

Write speaker notes as a continuous presentation, not isolated summaries. Each slide should have a short transition explaining why the next topic follows. Do not jump from a case study to “lessons learned,” for example, without stating the connection.

## Incremental revision

Map each comment to the affected slide and requirement. Assess it rather than applying it blindly, preserve approved content and design, and change only necessary objects. Update the affected manifest entry, notes, evidence links, and synchronization status in the same revision. Accumulate related visual edits and validate them together.
