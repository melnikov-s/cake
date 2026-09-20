import { Model, child, observable } from "r-state-tree";
import { LlmModel } from "./LlmModel";
import { ArtifactCatalog } from "./ArtifactCatalog";
import { Resource } from "./Resource";
import { CakeChatCatalog } from "./CakeChatCatalog";
import { ProjectCatalog } from "./ProjectCatalog";
import { Conversation } from "./Conversation";
import { SessionCatalog } from "./SessionCatalog";
import { WorktreeCatalog } from "./WorktreeCatalog";
import { WorktreeOperationCatalog } from "./WorktreeOperationCatalog";

/** Owns the authoritative data projections currently loaded in one renderer window. */
export class RootProjection extends Model {
  @child(LlmModel) llmModels: LlmModel[] = observable([]);
  @child(Resource) resources: Resource[] = observable([]);
  @child(ProjectCatalog) projects = ProjectCatalog.create();
  @child(SessionCatalog) sessionCatalog = SessionCatalog.create();
  @child(WorktreeCatalog) worktrees = WorktreeCatalog.create();
  @child(WorktreeOperationCatalog) worktreeOperations = WorktreeOperationCatalog.create();
  @child(CakeChatCatalog) cakeChatCatalog = CakeChatCatalog.create();
  @child(ArtifactCatalog) artifacts = ArtifactCatalog.create();
  @child(Conversation) projectConversations: Conversation[] = observable([]);
  @child(Conversation) cakeChatConversations: Conversation[] = observable([]);
  /** Live Discussion Session sidecars, keyed by their own Pi Session ID. */
  @child(Conversation) discussionConversations: Conversation[] = observable([]);

  projectConversation(sessionId: string, workingDirectory: string) {
    const existing = this.findProjectConversation(sessionId);
    if (existing) return existing;
    const session = Conversation.create({ sessionId, workingDirectory });
    this.projectConversations.push(session);
    return session;
  }

  findProjectConversation(sessionId: string) {
    return this.projectConversations.find((session) => session.sessionId === sessionId);
  }

  removeProjectConversation(sessionId: string) {
    const index = this.projectConversations.findIndex((session) => session.sessionId === sessionId);
    if (index >= 0) this.projectConversations.splice(index, 1);
  }

  cakeChatConversation(sessionId: string) {
    const existing = this.cakeChatConversations.find((session) => session.sessionId === sessionId);
    if (existing) return existing;
    const session = Conversation.create({ sessionId });
    this.cakeChatConversations.push(session);
    return session;
  }

  removeCakeChatConversation(sessionId: string) {
    const index = this.cakeChatConversations.findIndex(
      (session) => session.sessionId === sessionId,
    );
    if (index >= 0) this.cakeChatConversations.splice(index, 1);
  }

  discussionConversation(sessionId: string, workingDirectory: string) {
    const existing = this.findDiscussionConversation(sessionId);
    if (existing) return existing;
    const session = Conversation.create({ sessionId, workingDirectory });
    this.discussionConversations.push(session);
    return session;
  }

  findDiscussionConversation(sessionId: string) {
    return this.discussionConversations.find((session) => session.sessionId === sessionId);
  }

  removeDiscussionConversation(sessionId: string) {
    const index = this.discussionConversations.findIndex(
      (session) => session.sessionId === sessionId,
    );
    if (index >= 0) this.discussionConversations.splice(index, 1);
  }
}
