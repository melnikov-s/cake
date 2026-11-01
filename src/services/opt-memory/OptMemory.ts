import { Context, type Effect } from "effect";
import type {
  OptMemoryError,
  OptMemoryReadInput,
  OptMemoryView,
  OptMemoryWriteInput,
  OptMemoryWriteResult,
  OptMemoryZoom,
  OptMemoryZoomInput,
} from "../../contracts/memory/opt-memory-data";

/**
 * Persistence/provider boundary for reusable OptMem. No Layer is wired in the review skeleton.
 *
 * Extract the existing binary-tree compaction into this directory. Durable chat keeps
 * its original-entry selection, SQLite document/entry adapter, current prompt policy,
 * context handoff, exact recall and public Zoom presentation. It calls the extracted
 * core rather than retaining a second implementation of the compaction algorithm.
 *
 * Automation storage retains intentional memory notes and their provenance, not copies
 * of session transcripts. One serialized persistence owner per memory coordinates writes
 * from parallel sessions. Provider work stays outside storage transactions.
 *
 * Domain/tool callers enforce memory ownership and supply trusted session provenance.
 * Read returns the configured compact view; Zoom never changes another session's view.
 */
export class OptMemory extends Context.Service<
  OptMemory,
  {
    readonly read: (input: OptMemoryReadInput) => Effect.Effect<OptMemoryView, OptMemoryError>;
    readonly zoom: (input: OptMemoryZoomInput) => Effect.Effect<OptMemoryZoom, OptMemoryError>;
    readonly write: (
      input: OptMemoryWriteInput,
    ) => Effect.Effect<OptMemoryWriteResult, OptMemoryError>;
  }
>()("cake/services/opt-memory/OptMemory") {}
