import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { SessionCatalogUpdate } from "../../domain/application/catalog-data";
import { TurnId } from "../../domain/conversations/conversation-data";
import {
  ProjectSessionError,
  ProjectSessionCatalogQuery,
  ProjectSessionCompanionActionInput,
  ProjectSessionPreview,
  ProjectSessionProjection,
  ProjectSessionStartInput,
  ProjectSessionTarget,
  WorkingDirectoryResolutionResult,
} from "../../domain/project-sessions/project-session-data";
import { jsonObjectSchema, jsonValueSchema } from "../json-contract";
import { SESSION_TITLE_MAX_LENGTH } from "../session-contract";

export const ProjectSessionRpc = RpcGroup.make(
  Rpc.make("projectSessions.observeCatalog", {
    payload: ProjectSessionCatalogQuery,
    success: SessionCatalogUpdate,
    error: ProjectSessionError,
    stream: true,
  }),
  Rpc.make("projectSessions.inspect", {
    payload: ProjectSessionTarget,
    success: ProjectSessionPreview,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.readProjection", {
    payload: ProjectSessionTarget,
    success: ProjectSessionProjection,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.start", {
    payload: ProjectSessionStartInput,
    success: TurnId,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.open", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.getChangelog", {
    payload: ProjectSessionTarget,
    success: Schema.String,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.navigate", {
    payload: {
      ...ProjectSessionTarget.fields,
      entryId: Schema.String,
      summarize: Schema.Boolean,
      customInstructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
    },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.dispatchExtensionCompanionAction", {
    payload: ProjectSessionCompanionActionInput,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.callCakeOperation", {
    payload: {
      ...ProjectSessionTarget.fields,
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      input: jsonObjectSchema,
    },
    success: jsonValueSchema,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.toolCompact", {
    payload: {
      ...ProjectSessionTarget.fields,
      entryId: Schema.String,
      prompt: Schema.optional(Schema.String),
    },
    success: Schema.Struct({ sessionId: Schema.String }),
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.rename", {
    payload: {
      ...ProjectSessionTarget.fields,
      name: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH),
      ),
    },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.fork", {
    payload: {
      ...ProjectSessionTarget.fields,
      entryId: Schema.String,
      destinationWorkingDirectory: Schema.optional(Schema.String),
      resolveSource: Schema.optional(Schema.Boolean),
    },
    success: Schema.Struct({ sessionId: Schema.String }),
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.resolve", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.resolveWorkingDirectory", {
    payload: { workingDirectory: Schema.String },
    success: WorkingDirectoryResolutionResult,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.restore", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.respondControl", {
    payload: {
      sessionId: ProjectSessionTarget.fields.sessionId,
      controlRequestId: Schema.String.check(Schema.isUUID(4)),
      result: Schema.Json,
    },
    error: ProjectSessionError,
  }),
);
