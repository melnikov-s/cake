# Discovery projections and estimates

[Discovery](session-discovery.md) covers the normal route; this page explains compact fields and workflow interpretation.

## Compact rows

Discovery text is not JSON: projects.list, sessions.list-family, sessions.reports, models.list, attachments.list and messages.list use tab-separated rows with one header.
next=N continues with offset; attachments use after=ID, whose count is the visible page. Booleans use 1/0; - is absent. Tabs/newlines/quotes/backslashes in cells are JSON-quoted to preserve exact paths/references. Message input rows follow their message.
Details/bounded reads/errors/declared typed results keep their own contracts; listing never reads bodies or acknowledges a report.

## Workflow roster

sessions.list projection:workflow joins the invoking chat's retained launches, linked to-dos, latest results, resolution and worktree facts without runtime wake or transcript access.
Groups: working (including idle/unknown execution), waiting-for-input, ready-for-review/merge, blocked/stopped. Both listings exclude resolved history; neither includeResolved nor status:resolved is supported. Resolution-index failures fail the workflow request rather than listing potentially resolved launches.
Project callers default to their current project; Global Cake Chat defaults to all projects. Explicit projectPath overrides either default. query/status/attentionOnly filters apply before paging (default 20, maximum 50), nextOffset becomes offset.
Execution completion, resolution and result-decision state are separate. An explicit ready report permits review, not proof of merge readiness. Git dirty/head is unverified; landing checkpoints are recorded facts.
Missing old task labels use a worktree label or explicitly unknown task name; do not infer a title from private history.

## Context/cache fields

Compact sessions rows include id/status/lifecycle/outcome/tokens/cache/age/ttl and title; every row includes its canonical project path. Workflow rows also include project path. Returned identities are canonical; use them without enumerating directories to expand suffixes.
tokens (K/M) estimates active model-visible context, including summaries but not originals hidden behind them, never lifetime history/billing.
age is recorded model activity, not mtime. cache is warm, expired? (estimated window elapsed) or ?; ttl is estimated remaining time when creation-token evidence exists, negative after expiry, ? when unknown.
No field proves cache hit/miss; only a prefix may be reusable. Size/activity may lag. Never wake a session to ask size.
Regular estimates use persisted active Pi projection after pagination without runtime start. Permanent chats use Pi Durable's committed active head, not all history; older/unstarted chats may be unknown and next independent runs rebuild bounded memory.
sessions.info supplies identity/deepLink/workspace/effective lifecycle/outcome/activity metadata, not transcript/context reads.
