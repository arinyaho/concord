---
name: ticket-writing
description: Use when a user asks to draft, create, file, rewrite, refine, or update a development ticket or issue in Notion, Jira, GitHub Issues, or another tracker, especially when another agent will implement from it.
---

# Ticket Writing

A ticket is an implementation contract grounded in agreed intent and observed reality. It is not an idea dump, an investigation diary, or authority for its own claims.

## Ground the ticket

Before writing:

1. Resolve the tracker and project from the request or current workspace. If no destination can be established or multiple destinations remain plausible, ask before any tracker mutation. A content-only draft may proceed with the tracker and project explicitly unset.
2. Read the authoritative product brief, accepted requirements, and agreed design that govern the work. Record links and decision status. A draft or backlog proposal is context, not agreed direction.
3. Inspect current behavior in the shipped artifact or code path. Treat documents as intent, not proof of current behavior. Record observed evidence for every claim that motivates work.
4. Search for duplicate or superseding work when the tracker supports it. If one is found, stop before creating a ticket: reuse the existing work when it already covers the requested outcome, otherwise ask the user how to proceed.
5. Stop for a material product decision that the sources do not settle. If evidence refutes the premise, report the contradiction and stop before any tracker mutation. Revise or publish a different ticket only after the user explicitly confirms the corrected premise and scope. Require explicit approval before closing or superseding an existing ticket.

For an authorized tracker mutation, use the available authenticated provider integration. If none exists for the resolved destination, stop and report the missing access; never invent a provider, account, or project. Discover supported fields and statuses before writing. Leave optional metadata unset unless the user or an authoritative project source supplies it; never invent an assignee, priority, estimate, due date, label, or workflow state.

## Write this contract

Use provider-native fields and formatting while preserving these semantics:

| Section | Required content |
| --- | --- |
| Title | Specific outcome, not an activity |
| Outcome | User or system behavior that will be true |
| Context | Current behavior, problem, and observed evidence |
| Product and design alignment | Authoritative product source, agreed design, and decisions this work must preserve |
| Scope | Included deliverables and affected surfaces |
| Non-goals | Plausible adjacent work explicitly excluded |
| Constraints | Compatibility, security, operational, and migration boundaries |
| Design direction | Required boundaries plus known trade-offs and residual risks; do not pre-design unsettled implementation details |
| Acceptance criteria | Numbered, independently observable outcomes |
| Definition of done | Executable gates, plus any explicitly deferred gate with its owner and unblock condition |
| Dependencies and links | Only real blockers, related tickets, source documents, and artifacts |

Write conclusion-first. Keep discarded hypotheses and investigation chronology out of the ticket; retain only the verified conclusion and evidence.

Each Acceptance criteria item must name what an observer can distinguish. Assert identity and behavior, not only counts. Do not disguise implementation tasks as outcomes.

For a claimed defect, include a before/after check that proves the reported harm against unchanged and changed artifacts. For pure documentation work, the red condition is the identified contradiction or omission; do not invent runtime machinery.

A ticket is ready for implementation only when no unresolved question can materially change its outcome, scope, or design direction. Otherwise, preserve its current state, name the decision required in the body, and report that it is not implementation-ready. Use a draft or proposal state only when the provider exposes one and the requested workflow calls for it.

## Publish and verify

Before an authorized update, read the existing ticket and establish which title, body, fields, links, and status must be preserved. Create or update the ticket only when the user explicitly requests or approves that tracker mutation. A request to draft, rewrite, or refine ticket content without that authorization must return the content without mutating the tracker. After an authorized create or update, read the created or updated ticket back. Verify its title, body, fields, links, and actual status. Report rejected fields or transitions as failures; never claim a requested state was applied when the provider refused it.

If the user explicitly requests or approves an in-progress transition and the provider exposes an in-progress state, use its discovered transition without skipping preconditions. Otherwise, preserve the current state and report why no transition was applied.

## Handoff

Only when the user explicitly requests or approves implementation and an implementation workflow such as `ticket-to-pr` is available, hand the accepted ticket to it for code change and PR work. Ticket writing ends with a durable, implementation-ready contract; it does not perform the implementation.

## Example

> **Outcome:** Installed Codex plugins expose the same ticket-writing workflow as Claude plugins.
>
> **Evidence:** The Claude package contains the skill; a clean Codex package does not.
>
> **Product and design alignment:** Preserve the shared vendor-neutral capability and keep harness packaging thin.
>
> **Acceptance criteria:** A clean install of each plugin discovers the same skill bytes and provider-neutral behavior.
>
> **Definition of done:** The packaging regression test fails before the change, passes after it, and both installed packages are inspected.
