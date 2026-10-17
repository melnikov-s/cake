import type { BoardContinuation, BoardContinuationInput } from "./workboard-continuation";
import type {
  BoardAppendInput,
  BoardCurrentInput,
  BoardDescription,
  BoardDescriptionPage,
  BoardEntryReceipts,
  BoardPageInput,
  BoardReadResult,
  BoardSessionReceipts,
} from "./message-board";

/** Cake-owned Promise boundary; no Pi SDK values or storage authority cross it. */
export interface BoardNoticeEntry {
  readonly boardId: string;
  readonly sequence: number;
}

export interface MessageBoardControl {
  continuation?: {
    get(): Promise<{ boardId: string; policy: BoardContinuation | null }>;
    set(
      input: BoardContinuationInput,
      authorizationId: string,
    ): Promise<{ boardId: string; policy: BoardContinuation | null }>;
  };
  append(input: BoardAppendInput): Promise<{ boardId: string; entry: BoardDescription }>;
  readNew(
    input: BoardPageInput,
    notificationOnly?: boolean,
    excludeEntries?: ReadonlyArray<BoardNoticeEntry>,
  ): Promise<BoardDescriptionPage | undefined>;
  current(input: BoardCurrentInput): Promise<BoardDescriptionPage>;
  read(sequences: ReadonlyArray<number>): Promise<BoardReadResult>;
  entryReceipts(sequence: number): Promise<BoardEntryReceipts>;
  sessionReceipts(sessionId: string, input: BoardPageInput): Promise<BoardSessionReceipts>;
  recordIntake(
    boardId: string,
    sequences: ReadonlyArray<number>,
    kind: "notifiedAt" | "readAt",
  ): Promise<void>;
}
