import { agentListLabel } from "../../contracts/agent/agent-list-data";
import {
  CAKE_CHAT_REFERENCE,
  CAKE_CHAT_SESSION_ID,
} from "../../contracts/cake-chats/cake-chat-identity";
import type { AgentSessionStatus } from "../../contracts/project-sessions/agent-session-list";
import type { SessionContextMetadata } from "../../contracts/conversations/session-context-metadata";
import { sessionContextCost } from "../../utils/session-context-cost";

interface RosterRow {
  readonly sessionId: string;
  readonly title: string;
  readonly projectName?: string;
  readonly status: AgentSessionStatus;
  readonly resolved?: boolean;
  readonly outcome?: string;
  readonly contextMetadata?: SessionContextMetadata;
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const label = (value: string) => agentListLabel(value.replace(/[\r\n\t|]+/g, " "));

function duration(ms: number) {
  const seconds = Math.floor(Math.abs(ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Compact text keeps canonical routing IDs: a follow-up must not rediscover the global
 * identity universe just to expand a display suffix. Exact facts stay in sessions.info. */
export function sessionRoster(
  rows: readonly RosterRow[],
  page: { readonly total: number; readonly nextOffset: number | null },
  now: number,
  showProject: boolean,
) {
  const header = `${page.total} sessions${page.nextOffset === null ? "" : `; next=${page.nextOffset}`}`;
  const lines = [header];
  if (!rows.length) return header;
  lines.push(
    `id status lifecycle outcome tokens cache age ttl | ${showProject ? "project | " : ""}title`,
  );
  for (const row of rows) {
    const context = sessionContextCost(row.contextMetadata, now);
    const activity = context.lastModelActivityAt ? Date.parse(context.lastModelActivityAt) : NaN;
    const expiry = "estimatedExpiresAt" in context ? Date.parse(context.estimatedExpiresAt) : NaN;
    const age = Number.isFinite(activity) && activity <= now ? duration(now - activity) : "?";
    const ttl = Number.isFinite(expiry)
      ? `${expiry < now ? "-" : ""}${duration(expiry - now)}`
      : "?";
    const cache =
      context.cache === "potentially-expired"
        ? "expired?"
        : context.cache === "unknown"
          ? "?"
          : "warm";
    const tokens =
      context.estimatedTokens === undefined ? "?" : compactNumber.format(context.estimatedTokens);
    lines.push(
      `${row.sessionId === CAKE_CHAT_SESSION_ID ? CAKE_CHAT_REFERENCE : row.sessionId} ${row.status} ${row.resolved || row.status === "resolved" ? "resolved" : row.status === "draft" ? "draft" : "active"} ${row.outcome ?? "-"} ${tokens} ${cache} ${age} ${ttl} | ${showProject ? `${label(row.projectName ?? "—")} | ` : ""}${label(row.title)}`,
    );
  }
  return lines.join("\n");
}
