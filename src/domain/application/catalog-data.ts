import { Schema } from "effect";
import { ProjectRecord } from "./application-data";
import { ProjectSessionSummary } from "../project-sessions/project-session-data";
import { CakeChatSummary } from "../cake-chats/cake-chat-data";
import { DiscussionThread } from "../discussion-sessions/discussion-session-data";

const ProjectCatalogEvent = Schema.TaggedUnion({
  Replaced: { projects: Schema.Array(ProjectRecord) },
  Upserted: { project: ProjectRecord },
  Removed: { path: ProjectRecord.fields.path },
});

export const ProjectCatalogUpdate = Schema.TaggedUnion({
  Snapshot: {
    revision: Schema.Int,
    projects: Schema.Array(ProjectRecord),
  },
  Event: {
    revision: Schema.Int,
    event: ProjectCatalogEvent,
  },
});
export type ProjectCatalogUpdate = Schema.Schema.Type<typeof ProjectCatalogUpdate>;

const SessionCatalogEvent = Schema.TaggedUnion({
  Replaced: { sessions: Schema.Array(ProjectSessionSummary) },
  Upserted: { session: ProjectSessionSummary },
  UpsertedBatch: { sessions: Schema.Array(ProjectSessionSummary) },
  Removed: { sessionId: ProjectSessionSummary.fields.sessionId },
  RemovedBatch: { sessionIds: Schema.Array(ProjectSessionSummary.fields.sessionId) },
  StatusChanged: {
    sessionId: ProjectSessionSummary.fields.sessionId,
    resolved: Schema.Boolean,
    unread: Schema.Boolean,
  },
});

export const SessionCatalogUpdate = Schema.TaggedUnion({
  Snapshot: {
    revision: Schema.Int,
    sessions: Schema.Array(ProjectSessionSummary),
    hasMore: Schema.optionalKey(Schema.Boolean),
  },
  Event: {
    revision: Schema.Int,
    event: SessionCatalogEvent,
  },
});
export type SessionCatalogUpdate = Schema.Schema.Type<typeof SessionCatalogUpdate>;

const CakeChatCatalogEvent = Schema.TaggedUnion({
  Replaced: { sessions: Schema.Array(CakeChatSummary) },
  Upserted: { session: CakeChatSummary },
  Removed: { sessionId: CakeChatSummary.fields.sessionId },
  StatusChanged: {
    sessionId: CakeChatSummary.fields.sessionId,
    resolved: Schema.Boolean,
  },
});

export const CakeChatCatalogUpdate = Schema.TaggedUnion({
  Snapshot: {
    revision: Schema.Int,
    sessions: Schema.Array(CakeChatSummary),
    hasMore: Schema.optionalKey(Schema.Boolean),
  },
  Event: { revision: Schema.Int, event: CakeChatCatalogEvent },
});
export type CakeChatCatalogUpdate = Schema.Schema.Type<typeof CakeChatCatalogUpdate>;

const DiscussionCatalogEvent = Schema.TaggedUnion({
  Replaced: { threads: Schema.Array(DiscussionThread) },
});

export const DiscussionCatalogUpdate = Schema.TaggedUnion({
  Snapshot: {
    revision: Schema.Int,
    parentSessionId: Schema.String,
    threads: Schema.Array(DiscussionThread),
  },
  Event: {
    revision: Schema.Int,
    parentSessionId: Schema.String,
    event: DiscussionCatalogEvent,
  },
});
export type DiscussionCatalogUpdate = Schema.Schema.Type<typeof DiscussionCatalogUpdate>;
