import type { CrossSessionMessageMetadata } from "./cross-session-message";

/** Recognize Cake's exact persisted startup envelope, not arbitrary mentions of family work. */
export function familyBootstrapContext(
  text: string,
  metadata?: CrossSessionMessageMetadata,
): string | undefined {
  if (
    !metadata ||
    metadata.sequence !== 1 ||
    metadata.replyToMessageId ||
    metadata.sender.kind !== "project-session"
  )
    return undefined;
  const match =
    /^Read workgroups\.md and sessions\.md\. Your assignment is already persisted on the family Workboard: entry #(\d+), topic (child-[\w-]+)\. Read it with boards\.read before working\. Communicate with family members only on the Workboard\.$/.exec(
      text,
    );
  if (!match || match[2] !== `child-${metadata.messageId}`) return undefined;
  // Keep the bootstrap inspectable without presenting internal instructions as a parent's response
  // or suggesting that documentation basenames and tool names are workspace destinations.
  return text
    .replace("workgroups.md", "`workgroups.md`")
    .replace("sessions.md", "`sessions.md`")
    .replace("boards.read", "`boards.read`");
}
