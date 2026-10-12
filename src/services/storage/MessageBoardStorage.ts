import { Context, type Effect } from "effect";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import type {
  BoardAppendInput,
  BoardEntry,
  BoardReceipt,
  MessageBoardError,
} from "../../contracts/artifacts/message-board";

/** Artifact-owned append-only content; receipts are separate from content revisions. */
export class MessageBoardStorage extends Context.Service<
  MessageBoardStorage,
  {
    readonly append: (
      boardId: ArtifactLineageId,
      authorSessionId: string,
      input: BoardAppendInput,
    ) => Effect.Effect<BoardEntry, MessageBoardError>;
    readonly entries: (
      boardId: ArtifactLineageId,
    ) => Effect.Effect<ReadonlyArray<BoardEntry>, MessageBoardError>;
    readonly receipts: (
      boardId: ArtifactLineageId,
    ) => Effect.Effect<ReadonlyArray<BoardReceipt>, MessageBoardError>;
    readonly record: (
      boardId: ArtifactLineageId,
      sessionId: string,
      sequences: ReadonlyArray<number>,
      kind: "notifiedAt" | "readAt",
    ) => Effect.Effect<void, MessageBoardError>;
  }
>()("cake/services/storage/MessageBoardStorage") {}
