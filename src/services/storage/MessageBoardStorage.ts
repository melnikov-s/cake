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
    /** With a selection, read the suffix after `after` union the exact `sequences`.
     * Without `after`, only exact sequences are read; without a selection, read all.
     */
    readonly entries: (
      boardId: ArtifactLineageId,
      selection?: {
        readonly after?: number;
        readonly sequences?: ReadonlyArray<number>;
      },
    ) => Effect.Effect<ReadonlyArray<BoardEntry>, MessageBoardError>;
    /** Single delivery worker drains coalesced append changes; restart discovers persisted boards. */
    readonly takeChangedBoards: () => Effect.Effect<ReadonlyArray<ArtifactLineageId>>;
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
