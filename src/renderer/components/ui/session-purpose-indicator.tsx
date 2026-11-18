import { sessionPurposeLabel } from "../../../contracts/project-sessions/session-purpose";
import { sessionIdentityIcons, type SessionIdentityKind } from "../../lib/session-identity";
import { cn } from "../../lib/utils";

/** Relationship cue shared by session rows and links, never a to-do classification. */
export function SessionPurposeIndicator({
  purpose,
  className,
}: {
  purpose: SessionIdentityKind;
  className?: string;
}) {
  const label = purpose === "subagent" ? "Subagent" : sessionPurposeLabel(purpose);
  const Icon = sessionIdentityIcons[purpose];
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
      <Icon />
    </span>
  );
}
