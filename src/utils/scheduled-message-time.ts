import type { ScheduledMessageOrigin } from "../contracts/conversations/scheduled-message-envelope";

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

/** Live countdown: `0:12`, `2:41`, then `1h 20m` from one hour. */
export function formatCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds >= 3_600) {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Compact recurring interval: `90s`, `3m`, `2h`, `7d`. */
export function formatRepeatInterval(seconds: number) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Hover text for a pending schedule: its absolute send time and any repeat. */
export function describeScheduledSend(message: {
  readonly sendAt: string;
  readonly repeatEverySeconds?: number | undefined;
  readonly repeatUntil?: string | undefined;
}) {
  const at = new Date(message.sendAt).toLocaleString();
  if (message.repeatEverySeconds === undefined) return `Sends at ${at}`;
  const until = message.repeatUntil
    ? `until ${new Date(message.repeatUntil).toLocaleString()}`
    : "until cancelled";
  return `Sends at ${at}, then every ${formatRepeatInterval(message.repeatEverySeconds)} ${until}`;
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
