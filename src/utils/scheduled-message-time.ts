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
