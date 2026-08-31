import { Schema } from "effect";
import { ProjectRecord } from "./application-data";
import { ProjectSessionSummary } from "./project-session-data";

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
  Removed: { sessionId: ProjectSessionSummary.fields.sessionId },
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
  },
  Event: {
    revision: Schema.Int,
    event: SessionCatalogEvent,
  },
});
export type SessionCatalogUpdate = Schema.Schema.Type<typeof SessionCatalogUpdate>;
