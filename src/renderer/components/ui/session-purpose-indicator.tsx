import {
  sessionPurposeLabel,
  type SessionPurpose,
} from "../../../contracts/project-sessions/session-purpose";
import { BotIcon, UserIcon } from "./icons";
import { cn } from "../../lib/utils";

/** Relationship cue shared by session rows and links, never a to-do classification. */
export function SessionPurposeIndicator({
  purpose,
  className,
}: {
  purpose: SessionPurpose;
  className?: string;
}) {
  const label = sessionPurposeLabel(purpose);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-slot="session-purpose"
      data-purpose={purpose}
      className={cn(
        "inline-flex size-3 shrink-0 items-center justify-center align-[-0.125em] text-muted-foreground [&>svg]:size-3",
        className,
      )}
    >
      {purpose === "user" ? <UserIcon /> : <BotIcon />}
    </span>
  );
}
