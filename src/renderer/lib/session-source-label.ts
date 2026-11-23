export const SESSION_NAME_UNAVAILABLE = "Session name unavailable";

export function meaningfulSessionTitle(title: string | undefined, sessionId?: string) {
  const name = title?.trim();
  // Older receipts use the ID as a label. Protected task-input metadata may carry
  // the display placeholder "Task session" instead of a recorded title.
  return name &&
    name !== "Task session" &&
    (!sessionId || (name !== sessionId && name !== `Session ${sessionId}`))
    ? name
    : undefined;
}
