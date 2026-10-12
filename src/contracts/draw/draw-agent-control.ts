import type { DrawBoardMetadata } from "./draw-board-data";

import type { DrawControlInvocation, DrawControlResponse } from "./draw-control";

export interface CakeDrawControl {
  readonly list: (signal: AbortSignal) => Promise<ReadonlyArray<DrawBoardMetadata>>;
  readonly create: (title: string, signal: AbortSignal) => Promise<DrawBoardMetadata>;
  readonly open: (boardId: string, signal: AbortSignal) => Promise<typeof DrawControlResponse.Type>;
  readonly request: (
    invocation: DrawControlInvocation,
    signal: AbortSignal,
  ) => Promise<typeof DrawControlResponse.Type>;
  readonly exportFile: (
    path: string,
    content: Uint8Array,
    signal: AbortSignal,
  ) => Promise<{ readonly path: string; readonly bytes: number }>;
  readonly canMutate: () => boolean;
}
