import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  SavedDraft,
  SavedDraftConfiguration,
} from "../../domain/project-sessions/saved-draft-data";
import { SavedDraftError } from "../../services/storage/SavedDraftStorage";
import { ProjectSessionError } from "../../domain/project-sessions/project-session-data";
import { ManagedWorktreeError } from "../../services/worktrees/ManagedWorktrees";
import { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import { attachmentSchema } from "../session-contract";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";

const SessionId = SavedDraft.fields.sessionId;
export const SavedDraftCreateInput = Schema.Struct({
  sessionId: Schema.optionalKey(SessionId),
  projectPath: SavedDraft.fields.projectPath,
  title: SavedDraft.fields.title,
  text: SavedDraft.fields.text,
  attachments: Schema.Array(attachmentSchema),
  configuration: Schema.optionalKey(SavedDraftConfiguration),
  labelIds: Schema.optionalKey(SavedDraft.fields.labelIds),
  resolved: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.optionalKey(Schema.String),
  modifiedAt: Schema.optionalKey(Schema.String),
});
export const SavedDraftActivateInput = Schema.Struct({
  sessionId: SessionId,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  workingDirectory: Schema.optionalKey(Schema.String),
  worktreeName: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  ),
});
const RevisionInput = Schema.Struct({
  sessionId: SessionId,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const SavedDraftRpc = RpcGroup.make(
  Rpc.make("savedDrafts.list", {
    payload: Schema.Struct({}),
    success: Schema.Array(SavedDraft),
    error: SavedDraftError,
  }),
  Rpc.make("savedDrafts.observe", {
    payload: Schema.Struct({}),
    success: Schema.Array(SavedDraft),
    error: SavedDraftError,
    stream: true,
  }),
  Rpc.make("savedDrafts.create", {
    payload: SavedDraftCreateInput,
    success: SavedDraft,
    error: Schema.Union([SavedDraftError, ManagedWorktreeError]),
  }),
  Rpc.make("savedDrafts.update", {
    payload: Schema.Struct({
      record: SavedDraft,
      expectedRevision: RevisionInput.fields.expectedRevision,
    }),
    success: SavedDraft,
    error: Schema.Union([SavedDraftError, ManagedWorktreeError]),
  }),
  Rpc.make("savedDrafts.remove", { payload: RevisionInput, error: SavedDraftError }),
  Rpc.make("savedDrafts.recoverUncertain", {
    payload: Schema.Struct({
      ...RevisionInput.fields,
      confirmedNoTurn: Schema.Literal(true),
    }),
    success: SavedDraft,
    error: SavedDraftError,
  }),
  Rpc.make("savedDrafts.activate", {
    payload: SavedDraftActivateInput,
    success: Schema.Struct({
      record: SavedDraft,
      workingDirectory: Schema.String,
      managedWorktree: Schema.optionalKey(WorktreeRecord),
    }),
    error: Schema.Union([SavedDraftError, ProjectSessionError, ManagedWorktreeError]),
  }),
).middleware(RendererConnectionMiddleware);
