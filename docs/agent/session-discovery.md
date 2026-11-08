# Discovery

## Route directly

projects.list/info returns canonical projectChatId; use it directly for sends/open, even before first visit. A known address needs no source grep, hashing, AGENTS/history inspection or discovery round trip.
Canonical IDs or discovered unique hex suffixes route; titles do not. Unknown/ambiguous refs fail. Suffixes are at least eight trailing hex characters (UUID hyphens removed); rediscover/extend rather than guess.
Navigation needs user permission. Send/open receipts do not prove execution or visible pixels; opening does not drain passive FYIs. Offer a titled sessions.info deepLink when navigation is unavailable.

## List selectively

sessions.list: only non-resolved sessions, including idle, Draft and done-but-unresolved sessions; never resolved history. Every row includes project identity. projection:"workflow" adds launch/result/lifecycle groups. Page with nextOffset/offset.
Project callers default to their current project; Global Cake Chat defaults to all projects. Any caller can supply projectPath to target a project instead. Discover projects with projects.list. Workflow projection describes the invoking chat's non-resolved launches in that project, not every session. Use sessions.info for known historical IDs or the UI history/search surfaces for resolved history.
Listings do not read bodies or acknowledge reports. sessions.info provides metadata/deepLink, not transcript/context inspection.
Compact listings use tab-separated rows: 1/0 booleans, - absent, JSON-quoted special cells. next=N means offset=N; attachments use after=ID. Child input rows belong to the preceding message.

## Interpret estimates

Context/cache estimates are advisory, not billing or hit/miss proof; never wake a session just for size. Tokens estimate active visible context, not lifetime history. age is model activity, not mtime; ttl can be unknown/elapsed.
Lifecycle, execution outcome and user review decisions are independent. Workflow labels/landing checkpoints are retained facts; Git dirty/head/readiness is not freshly verified.
[Discovery details](session-discovery-details.md) explains pagination, workflow groups and estimate sources. [Delivery](communication.md) explains receipt semantics.
