import type { Schema } from "effect";
import { sessionLink } from "../conversations/message-reference";
import { workflowRosterGroups, type WorkflowRoster } from "../project-sessions/workflow-roster";

const cell = (value: string) => (/[\t\r\n"\\]/.test(value) ? JSON.stringify(value) : value);

export function workflowRosterText(result: Schema.Schema.Type<typeof WorkflowRoster>) {
  const counts = workflowRosterGroups.map((group) => `${group}=${result.counts[group]}`).join(" ");
  const lines = [
    `${result.total} launches${result.nextOffset === null ? "" : `; next=${result.nextOffset}`} | ${counts}`,
    "Recorded metadata only; working includes idle/unknown. Merge=unknown is unverified. Result=latest retained link; decision is not resolution/unreadness.",
  ];
  if (result.sessions.length)
    lines.push(
      "group\ttask\tsession\tlifecycle\texecution\treason\tresult\toutcome\tdecision\tworktree\tmerge\tnext\tproject\tpurpose",
    );
  for (const row of result.sessions)
    lines.push(
      ("group" in row
        ? [
            row.group,
            row.title,
            sessionLink(row.sessionId),
            row.lifecycle,
            row.execution,
            row.reason,
            row.result,
            row.outcome,
            row.decision,
            row.worktree,
            row.merge,
            row.next,
            row.projectPath,
            row.purpose,
          ]
        : [
            "redacted",
            row.title,
            sessionLink(row.sessionId),
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
            "-",
          ]
      )
        .map(cell)
        .join("\t"),
    );
  return lines.join("\n");
}
