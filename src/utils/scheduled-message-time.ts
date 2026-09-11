import type { ScheduledMessageOrigin } from "../domain/scheduled-messages/scheduled-message-envelope";

export interface ScheduledOriginDescription {
  /** Compact clock-time summary for inline labels. */
  summary: string;
  /** Full local timestamps for hover text. */
  detail: string;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Describes when a delivered scheduled message was created and when its schedule fired. */
export function describeScheduledOrigin(
  origin: Pick<ScheduledMessageOrigin, "createdAt" | "sendAt">,
): ScheduledOriginDescription {
  return {
    summary: `scheduled ${clock(origin.createdAt)} · sent ${clock(origin.sendAt)}`,
    detail: `Scheduled ${new Date(origin.createdAt).toLocaleString()} · sent ${new Date(origin.sendAt).toLocaleString()}`,
  };
}

export interface ParsedScheduledMessage {
  sendAt: string;
  text: string;
}

/** Parses `<number><s|m|h|d> <message>` or `<ISO timestamp> <message>`. */
export function parseScheduledMessage(value: string, now = Date.now()): ParsedScheduledMessage {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(value.trim());
  if (!match) throw new Error("Usage: /schedule <10s|5m|2h|1d|ISO time> <message>");
  const when = match[1]!;
  const text = match[2]!.trim();
  const duration = /^(\d+)(s|m|h|d)$/i.exec(when);
  const unit = duration?.[2]?.toLocaleLowerCase();
  const multiplier =
    unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const timestamp = duration ? now + Number(duration[1]) * multiplier : Date.parse(when);
  if (!Number.isFinite(timestamp) || timestamp <= now)
    throw new Error("Schedule time must be a valid future duration or ISO timestamp");
  if (!text) throw new Error("A scheduled message cannot be empty");
  return { sendAt: new Date(timestamp).toISOString(), text };
}
