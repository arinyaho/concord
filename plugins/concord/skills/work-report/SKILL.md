---
name: work-report
description: Use when organizing work or preparing daily, weekly, monthly, arbitrary-period, project, or team status reports from connected services, including 업무 정리, 업무 보고, 주간 보고, and daily work summaries. Not for merely summarizing one supplied document or changing tracker status.
---

# Work Report

Turn connected-service evidence into a concise account of outcomes, open work, blockers, and next actions. This workflow supports Claude Code and Codex; it assumes no company, workspace, provider, or credential manager.

## Establish scope

Support daily, weekly, monthly, arbitrary date ranges, milestone summaries, and on-demand work organization; never assume a weekly cadence. Resolve the reporting period, timezone, person/team/project, audience, and requested output from the request and current context. State reasonable assumptions and proceed; ask only when ambiguity would materially change which account or work is included. Convert relative dates into explicit boundaries and query a half-open interval in the user's timezone. Distinguish activity during the period from current status at retrieval time.

Discover the services and read/search tools actually connected in this runtime. Use the relevant subset: trackers and repositories for work state, documents for deliverables, chat/mail for decisions and commitments, calendar for scheduled work. These are examples, not dependencies. Honor the user's source choices. Do not require a company domain, project key, local token file, CLI, or an uninstalled skill.

Resolve the actual account/workspace before querying. Keep different identities separate unless source evidence establishes the mapping. Never assume that switching a CLI profile changes a connector's account. If access is missing, continue independent sources and mark the report partial; do not substitute another account or invent data. Read source-specific skill instructions when available and needed.

## Collect cheaply

Read [collection.md](references/collection.md) before delegating collection. Use a supported low-cost worker for bounded searching, pagination, field extraction, and normalization: Codex `gpt-6-luna` when callable, Claude Code `haiku` when callable, or an available lightweight equivalent. Resolve the actual supported model/alias at invocation time; examples do not promise availability. A role name alone does not select a cheaper model.

Batch related small queries in one worker. Give it only the scope, source/account, query limits, and evidence contract, rather than the conversation or full archives. A trivial single lookup can stay local when delegation costs more. Keep synthesis, contradiction resolution, prioritization, final wording, and review with the primary agent. Workers extract facts; they do not decide what counts as delivered.

The worker must have the same authorized service access. If model selection or connector access cannot be delegated, run narrowly scoped direct tool calls, disclose the fallback, and avoid routing raw archives through an expensive model. Do not claim cheap-model execution unless a selected worker actually ran. Escalate ambiguous extraction with the evidence needed to resolve it; do not silently turn collection into expensive analysis.

## Reconcile and organize

Read [reporting.md](references/reporting.md) when preparing a multi-source report: use plans as the intended-work frame, compare with observed outcomes, and preserve next-step evidence.

Deduplicate by canonical source ID and relate cross-service references without counting the same work twice. Preserve the distinction between tracker state, observed artifacts, and claims in messages. A meeting invite is scheduled activity, a PR merge is a repository outcome, and neither alone proves deployment. When sources disagree, show the discrepancy and source times; an open PR alone does not prove that no alternate deployment happened.

Keep accomplishments tied to evidence. Separate completed outcomes, ongoing work, decisions, blockers/dependencies, and proposed next actions as useful for the audience. Preserve source owners and deadlines; label inferred or proposed actions and never invent assignments or commitments. Do not treat missing activity as proof of inactivity, or infer productivity from message/commit counts.

For work organization, propose grouping and next actions in the answer. A request to summarize or organize does not authorize rewriting source records, moving tasks, changing statuses, sending messages, or scheduling recurring reports.

## Deliver and verify

Use the user's format, language, and level of detail. A useful default is a short overview followed by outcomes, ongoing work/blockers, and next actions, with source links beside material claims. Include the exact reporting interval/timezone, status retrieval time, and compact coverage note identifying failed, truncated, or unqueried sources. Separate “no matching items” from “not checked.” Never claim completeness after a page or access limit.

Before finalizing, check evidence for completion claims, duplicate counts, unresolved contradictions, owners/dates, and source coverage. If the user explicitly requests saving or posting, resolve the real destination and permissions, prepare the content, perform only the authorized write, and read it back. Otherwise return the report in chat. Do not send or schedule anything merely because it is called a report.
