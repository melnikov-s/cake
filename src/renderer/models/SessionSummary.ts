import { Model, id } from "r-state-tree";
import type { ManagedWorktreeContext } from "../../services/project-sessions/ProjectSessionEnvironment";

export class SessionSummary extends Model {
  @id sessionId = "";
  title = "";
  createdAt = "";
  modifiedAt = "";
  messageCount = 0;
  parentSessionId: string | undefined;
  resolved = false;
  unread = false;
  projectPath = "";
  projectName = "";
  workingDirectory = "";
  managedWorktree: ManagedWorktreeContext | undefined;
  pending = false;
  draft = false;
}
