import type { BoardDelivery } from "./board-delivery";
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
  deliveryExclusions(): Promise<
    { boardId: string; paused: boolean; sequences: ReadonlyArray<number> } | undefined
  >;
  append(input: BoardAppendInput): Promise<{
    boardId: string;
    entry: BoardDescription;
    scheduledRecipients?: ReadonlyArray<string>;
    deliveries?: ReadonlyArray<BoardDelivery>;
  }>;
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
