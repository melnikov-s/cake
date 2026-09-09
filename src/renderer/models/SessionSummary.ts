import { Model, id } from "r-state-tree";
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
  worktreeName: string | undefined;
  familyId: string | undefined;
  familyParentSessionId: string | undefined;
  familyChildSessionIds: readonly string[] | undefined;
  familyChildOrder: number | undefined;
  pending = false;
  draft = false;
}
