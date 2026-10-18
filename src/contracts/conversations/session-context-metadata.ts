import { Schema } from "effect";

const tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Advisory model-context facts, never transcript size or a promise of cache reuse. */
export const SessionContextMetadata = Schema.Struct({
  estimatedTokens: tokens,
  lastModelActivityAt: Schema.optionalKey(Schema.String),
  cacheObservation: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.String,
      observedAt: Schema.String,
      readTokens: tokens,
      writeTokens: tokens,
      write1hTokens: Schema.optionalKey(tokens),
    }),
  ),
});
export interface SessionContextMetadata extends Schema.Schema.Type<typeof SessionContextMetadata> {}
