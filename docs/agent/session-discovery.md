# Discovery

## Route directly

projects.list/info returns canonical projectChatId; use it directly for sends/open, even before first visit. A known address needs no source grep, hashing, AGENTS/history inspection or discovery round trip.
Canonical IDs or discovered unique hex suffixes route; titles do not. Unknown/ambiguous refs fail. Suffixes are at least eight trailing hex characters (UUID hyphens removed); rediscover/extend rather than guess.
Navigation needs user permission. Send/open receipts do not prove execution or visible pixels; opening does not drain passive FYIs. Offer a titled sessions.info deepLink when navigation is unavailable.

## List selectively

sessions.list: scoped metadata; projection:"workflow" adds launch/result/lifecycle groups. includeResolved requires workflow projection. Page with nextOffset/offset.
Project callers see their project; global Cake Chat can span registered projects. projectPath narrows, never expands scope. Workflow projection describes the invoking chat's launches, not every session.
Listings do not read bodies or acknowledge reports. sessions.info provides metadata/deepLink, not transcript/context inspection.
Compact listings use tab-separated rows: 1/0 booleans, - absent, JSON-quoted special cells. next=N means offset=N; attachments use after=ID. Child input rows belong to the preceding message.

## Interpret estimates

Context/cache estimates are advisory, not billing or hit/miss proof; never wake a session just for size. Tokens estimate active visible context, not lifetime history. age is model activity, not mtime; ttl can be unknown/elapsed.
Lifecycle, execution outcome and user review decisions are independent. Workflow labels/landing checkpoints are retained facts; Git dirty/head/readiness is not freshly verified.
[Discovery details](session-discovery-details.md) explains pagination, workflow groups and estimate sources. [Delivery](communication.md) explains receipt semantics.
