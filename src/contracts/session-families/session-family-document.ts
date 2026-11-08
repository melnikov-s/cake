import { Schema } from "effect";
import { MessageReference } from "../conversations/message-reference";
import { StoredPassiveNotice } from "../conversations/passive-notice";
import { PendingReport, ReportHandlingReceipt } from "../conversations/pending-report";
import { BoardDelivery } from "../artifacts/board-delivery";
import { AutoMergeRequest } from "../worktrees/auto-merge";
import { CompletionInboxItem } from "../conversations/completion-inbox";
import { ResultDelivery } from "../conversations/result-delivery";
import { TurnStop } from "../conversations/turn-stop";
import {
  CakeChatLaunchReport,
  CakeChatLaunchStatus,
  SessionCompletionReport,
  SessionRequester,
} from "../project-sessions/session-reporting";

const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const BoundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export const NOTICE_DELIVERY_MAX_FAILURES = 3;
export const NoticeDeliveryRetry = Schema.Struct({ id: BoundedId });
export interface NoticeDeliveryRetry extends Schema.Schema.Type<typeof NoticeDeliveryRetry> {}

export const SessionFamilyChild = Schema.Struct({
  sessionId: BoundedId,
  parentSessionId: BoundedId,
  requestId: BoundedId,
  workingDirectory: BoundedPath,
  managedWorktreePath: Schema.optionalKey(BoundedPath),
  /** Assignment-first reservations survive restart before durable admission. */
  assignmentTopic: Schema.optionalKey(BoundedId),
  /** Exact creation-owned entry; retained when delivery scans only newer entries. */
  assignmentSequence: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  createdAt: Schema.String,
});
export interface SessionFamilyChild extends Schema.Schema.Type<typeof SessionFamilyChild> {}

export const SessionFamily = Schema.Struct({
  familyId: BoundedId,
  parentSessionId: BoundedId,
  projectPath: BoundedPath,
  workingDirectory: BoundedPath,
  managedWorktreePath: Schema.optionalKey(BoundedPath),
  createdAt: Schema.String,
  children: Schema.Array(SessionFamilyChild),
  /** Entries already accounted for in durable delivery batches, including irrelevant posts. */
  boardDeliveryThrough: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export interface SessionFamily extends Schema.Schema.Type<typeof SessionFamily> {}

export interface SessionFamilyMember {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly workingDirectory: string;
  readonly managedWorktreePath?: string;
}

export const familyMember = (
  family: SessionFamily,
  sessionId: string,
): SessionFamilyMember | undefined => {
  if (family.parentSessionId === sessionId) {
    const root: SessionFamilyMember = {
      sessionId,
      workingDirectory: family.workingDirectory,
    };
    if (family.managedWorktreePath !== undefined)
      Object.assign(root, { managedWorktreePath: family.managedWorktreePath });
    return root;
  }
  return family.children.find((child) => child.sessionId === sessionId);
};

export const familyChildren = (family: SessionFamily, parentSessionId: string) =>
  family.children.filter((child) => child.parentSessionId === parentSessionId);

export const familyMemberIds = (family: SessionFamily) => [
  family.parentSessionId,
  ...family.children.map((child) => child.sessionId),
];

export const familyDepth = (family: SessionFamily, sessionId: string) => {
  let depth = 0;
  let member = familyMember(family, sessionId);
  const visited = new Set<string>();
  while (member?.parentSessionId !== undefined) {
    if (visited.has(member.sessionId)) return undefined;
    visited.add(member.sessionId);
    depth += 1;
    member = familyMember(family, member.parentSessionId);
  }
  return member ? depth : undefined;
};

export const SpawnedSession = Schema.Struct({
  sessionId: BoundedId,
  /** Launch label retained independently of Pi content for metadata-only discovery. */
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  projectPath: BoundedPath,
  workingDirectory: BoundedPath,
  requester: SessionRequester,
  reportDelivered: Schema.Boolean,
  /** A factual stop notice is a settled handoff, but not a successful result report. */
  handoffSettled: Schema.Boolean,
  launchedAt: Schema.optionalKey(Schema.String),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  /** Latest result Cake Chat received (immediately or by digest), for status surfaces. */
  lastReport: Schema.optionalKey(CakeChatLaunchReport),
});
export interface SpawnedSession extends Schema.Schema.Type<typeof SpawnedSession> {}

/**
 * One pending reply obligation. Cake records it only when an accepted incoming
 * message selected reply or notification; the turn that consumes that
 * message owes exactly one result (or one factual failure notice), after which
 * the record is removed. Turns without a record never notify anyone.
 */
export const FamilyTurn = Schema.Struct({
  report: Schema.optionalKey(SessionCompletionReport),
  /** The session executing the request. */
  sessionId: BoundedId,
  /** The session that asked for the response. */
  senderSessionId: BoundedId,
  turnId: BoundedId,
  requestMessageId: BoundedId,
  threadId: BoundedId,
  reported: Schema.Boolean,
  deliveryTurnId: Schema.optionalKey(BoundedId),
  /** Last failed handoff attempt; the obligation remains open for retry. */
  deliveryError: Schema.optionalKey(Schema.String),
  /** Exhausted deliveries remain durable until explicitly retried. */
  deliveryFailureCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  replyMessageIds: Schema.optionalKey(Schema.Array(BoundedId)),
  outcome: Schema.optionalKey(Schema.Literals(["complete", "failed", "aborted"])),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  /** Who deliberately stopped an aborted turn. Absent on an unexpected interruption. */
  stop: Schema.optionalKey(TurnStop),
});
export interface FamilyTurn extends Schema.Schema.Type<typeof FamilyTurn> {}
/** One quiet status line waiting for the user's next Cake Chat message. */
export const CoordinatorDigestItem = Schema.Struct({
  /** Absent denotes the global chat, including existing persisted inbox items. */
  coordinatorSessionId: Schema.optionalKey(BoundedId),
  /** Backend outcomes may wait for real user input without scheduling a wake. */
  userInputOnly: Schema.optionalKey(Schema.Boolean),
  /** The settled obligation's turn ID; digesting is idempotent per turn. */
  id: BoundedId,
  sessionId: BoundedId,
  title: Schema.String.check(Schema.isMaxLength(500)),
  resultMessageRef: Schema.optionalKey(MessageReference),
  status: CakeChatLaunchStatus,
  summary: Schema.String.check(Schema.isMaxLength(2000)),
  reportedAt: Schema.String,
});
export interface CoordinatorDigestItem extends Schema.Schema.Type<typeof CoordinatorDigestItem> {}
/**
 * One open batch timer per recipient conversation. Opened when the first deferred update
 * arrives in an empty batch; delivered at dueAt or carried by the next user message.
 * turnId records an admission attempt so a restart reconciles instead of resending.
 */
export const UpdateBatch = Schema.Struct({
  recipientSessionId: BoundedId,
  openedAt: Schema.String,
  dueAt: Schema.String,
  turnId: Schema.optionalKey(BoundedId),
});
export interface UpdateBatch extends Schema.Schema.Type<typeof UpdateBatch> {}
export const SessionFamilyDocument = Schema.Struct({
  families: Schema.Array(SessionFamily),
  turns: Schema.Array(FamilyTurn),
  spawnedSessions: Schema.Array(SpawnedSession),
  /** Cake Chat's inbox of digest-policy results, drained into its next user message. */
  coordinatorDigest: Schema.optionalKey(Schema.Array(CoordinatorDigestItem)),
  deferredReferences: Schema.optionalKey(Schema.Array(PendingReport)),
  passiveNotices: Schema.optionalKey(Schema.Array(StoredPassiveNotice)),
  handledReports: Schema.optionalKey(Schema.Array(ReportHandlingReceipt)),
  boardDeliveries: Schema.optionalKey(Schema.Array(BoardDelivery)),
  boardDeliveryPaused: Schema.optionalKey(Schema.Array(BoundedId)),
  completionInbox: Schema.optionalKey(Schema.Array(CompletionInboxItem)),
  autoMergeRequests: Schema.optionalKey(Schema.Array(AutoMergeRequest)),
  updateBatches: Schema.optionalKey(Schema.Array(UpdateBatch)),
});
export interface SessionFamilyDocument extends Schema.Schema.Type<typeof SessionFamilyDocument> {}
