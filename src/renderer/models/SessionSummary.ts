import { Schema } from "effect";
import { Model, createModel, type ModelInstance } from "effect-state-tree";
import { ProjectSessionSummary } from "../../domain/project-session-data";

export const SessionCatalogEntry = Schema.Struct({
  summary: ProjectSessionSummary,
  draft: Schema.Boolean,
  rendererOwned: Schema.Boolean,
});
export interface SessionCatalogEntry extends Schema.Schema.Type<typeof SessionCatalogEntry> {}

export const SessionSummary = createModel(
  "SessionSummary",
  Schema.Struct({
    identity: Model.id(ProjectSessionSummary.fields.sessionId),
    entry: SessionCatalogEntry,
  }),
  (self) => ({
    get id() {
      return self.identity.value;
    },
    get sessionId() {
      return self.identity.value;
    },
    get title() {
      return self.entry.value.summary.title;
    },
    get created() {
      return self.entry.value.summary.createdAt;
    },
    get modified() {
      return self.entry.value.summary.modifiedAt;
    },
    get messageCount() {
      return self.entry.value.summary.messageCount;
    },
    get parentSessionId() {
      return self.entry.value.summary.parentSessionId;
    },
    get resolved() {
      return self.entry.value.summary.resolved;
    },
    get unread() {
      return self.entry.value.summary.unread;
    },
    get projectPath() {
      return self.entry.value.summary.projectPath;
    },
    get workspacePath() {
      return self.entry.value.summary.workingDirectory;
    },
    get workspaceName() {
      return self.entry.value.summary.projectName;
    },
    get managedWorktree() {
      return self.entry.value.summary.managedWorktree;
    },
    get draft() {
      return self.entry.value.draft;
    },
    update(entry: SessionCatalogEntry) {
      if (entry.summary.sessionId !== self.identity.value)
        throw new Error("A Session summary update cannot change its identity");
      self.entry.set({
        summary: { ...entry.summary },
        draft: entry.draft,
        rendererOwned: entry.rendererOwned,
      });
    },
  }),
);

export type SessionSummary = ModelInstance<typeof SessionSummary>;
