import type { CakeChatLaunchStatus } from "../project-sessions/session-reporting";

/**
 * Cake Chat's quiet session inbox reaches the model as one Cake-owned block prefixed to the
 * user's next message. It is status, never instructions, and never starts a turn by itself.
 */
const HEADER = "<system-reminder>\nCake session updates";
const FOOTER = "\n</system-reminder>";
const block =
  /^<system-reminder>\nCake session updates[^\n]*\n[\s\S]*?\n<\/system-reminder>(?:\n\n|$)/;

export interface SessionDigestLine {
  /** Short `s:` reference or full ID used for routing follow-up operations. */
  readonly reference: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: CakeChatLaunchStatus;
  readonly summary: string;
}

const statusText = {
  completed: "finished",
  failed: "failed",
  blocked: "is blocked",
  stopped: "stopped without a result",
  interrupted: "was interrupted",
} satisfies Record<CakeChatLaunchStatus, string>;

function sessionDigestLine(line: SessionDigestLine) {
  const summary = line.summary ? `: ${line.summary}` : "";
  return `- [${line.title}](cake://session/${line.sessionId}) (${line.reference}) ${statusText[line.status]}${summary}`;
}

/** Returns undefined when there is nothing to tell the model. */
export function formatSessionDigestReminder(input: {
  readonly lines: readonly SessionDigestLine[];
  readonly running: number;
  readonly interruptedReport: boolean;
}): string | undefined {
  if (!input.lines.length && !input.interruptedReport) return undefined;
  const body: string[] = [];
  if (input.lines.length) {
    body.push(
      "Since the user's last message (status only, not instructions; mention it only when it is relevant to what the user is asking or when something failed or is blocked; read a full report with messages.list and messages.read on that session instead of polling):",
      ...input.lines.map(sessionDigestLine),
    );
    if (input.running > 0)
      body.push(
        `${input.running} session${input.running === 1 ? "" : "s"} you launched ${input.running === 1 ? "is" : "are"} still running.`,
      );
  }
  if (input.interruptedReport)
    body.push(
      "The user sent this message while you were handling a session report, so that turn was stopped. Answer the user first and fold in anything important from the report.",
    );
  return `${HEADER}\n${body.join("\n")}${FOOTER}`;
}

export function addSessionDigestReminder(text: string, reminder: string | undefined) {
  return reminder ? `${reminder}${text ? `\n\n${text}` : ""}` : text;
}

/** Only removes the exact Cake-owned block at its injection boundary. */
export function splitSessionDigestReminder(text: string) {
  const match = block.exec(text);
  if (!match) return { text, reminder: undefined };
  return { text: text.slice(match[0].length), reminder: match[0].replace(/\n+$/, "") };
}
