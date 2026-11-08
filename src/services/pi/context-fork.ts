import type { Message } from "@earendil-works/pi-ai";

/** Transient SDK-to-SDK context transfer. Only Pi stores the inherited transcript. */
export interface PiContextFork {
  readonly entryId: string;
  readonly messages: readonly Message[];
}
