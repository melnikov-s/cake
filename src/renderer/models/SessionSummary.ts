import { Model, id } from "r-state-tree";
import type { ProjectSessionSummary } from "../../contracts/project-sessions/project-session-data";
export class SessionSummary extends Model {
  @id sessionId = "";
  title = "";
  createdAt = "";
  modifiedAt = "";
  messageCount = 0;
  parentSessionId: string | undefined;
  resolved = false;
  unread = false;
  running = false;
  projectPath = "";
  projectName = "";
  workingDirectory = "";
  worktreeName: string | undefined;
  familyId: string | undefined;
  familyParentSessionId: string | undefined;
  familyChildSessionIds: readonly string[] | undefined;
  familyChildOrder: number | undefined;
  familyDepth: number | undefined;
  cakeChatLaunch: ProjectSessionSummary["cakeChatLaunch"];
  pending = false;
  draft = false;
}
