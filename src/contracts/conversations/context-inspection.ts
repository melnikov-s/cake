import { Schema } from "effect";

/** An ephemeral read-only projection, never a second transcript or prompt authority. */
export interface ContextInspectionNode {
  readonly id: string;
  readonly title: string;
  readonly text?: string;
  readonly source?: string;
  readonly kind?: "summary" | "original";
  /** Summary-tree layers above originals, not UI nesting or model-call count. Originals are depth 0. */
  readonly summaryDepth?: number;
  readonly children?: readonly ContextInspectionNode[];
  readonly detail?: {
    readonly entryId?: string;
    readonly memoryId?: number;
    readonly memoryCount?: number;
    readonly offset?: number;
  };
}

export const ContextInspectionNode: Schema.Codec<ContextInspectionNode> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  text: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literals(["summary", "original"])),
  summaryDepth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  children: Schema.optionalKey(Schema.Array(Schema.suspend(() => ContextInspectionNode))),
  detail: Schema.optionalKey(
    Schema.Struct({
      entryId: Schema.optionalKey(Schema.String),
      memoryId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      memoryCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
});

export const ContextInspection = Schema.Struct({ sources: Schema.Array(ContextInspectionNode) });
export interface ContextInspection extends Schema.Schema.Type<typeof ContextInspection> {}
export const decodeContextInspection = Schema.decodeUnknownSync(ContextInspection);
