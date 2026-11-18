import type { SessionPurpose } from "../../contracts/project-sessions/session-purpose";
import { BotIcon, SparkleIcon, UserIcon } from "../components/ui/icons";

/** Presentation identity only; a private subagent is not a Project Session purpose. */
export type SessionIdentityKind = SessionPurpose | "subagent";

export const sessionIdentityIcons = {
  user: UserIcon,
  delegated: BotIcon,
  subagent: SparkleIcon,
} satisfies Record<SessionIdentityKind, typeof UserIcon>;
