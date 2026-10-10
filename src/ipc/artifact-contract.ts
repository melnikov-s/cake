import { Schema } from "effect";

const ARTIFACT_PROTOCOL = "cake.artifact/v1" as const;
export const MAX_ARTIFACT_INPUT_BYTES = 1_048_576;
export const artifactKindSchema = Schema.Literals([
  "markdown",
  "table",
  "diagram",
  "media",
  "diff",
  "html",
  "widget",
  "file",
]);
export const idSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const provenanceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const textSchema = Schema.String.check(Schema.isMaxLength(MAX_ARTIFACT_INPUT_BYTES));
const scalarSchema = Schema.Union([
  Schema.String.check(Schema.isMaxLength(262_144)),
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  Schema.Null,
]);
const artifactBase = {
  protocol: Schema.Literal(ARTIFACT_PROTOCOL),
  id: idSchema,
  sessionId: idSchema,
  revision: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  fallback: Schema.Struct({ markdown: textSchema }),
  interaction: Schema.optional(Schema.Struct({ mode: Schema.Literal("present") })),
};
const markdownArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("markdown"),
  payload: Schema.Struct({ markdown: textSchema }),
});
const tableArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("table"),
  payload: Schema.Struct({
    columns: Schema.Array(
      Schema.Struct({
        id: idSchema,
        label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
        type: Schema.optional(Schema.Literals(["text", "number", "boolean", "date"])),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    rows: Schema.Array(
      Schema.StructWithRest(Schema.Struct({ id: idSchema }), [
        Schema.Record(Schema.String, scalarSchema),
      ]),
    ).check(Schema.isMaxLength(20_000)),
    selectable: Schema.optional(Schema.Boolean),
  }),
});
const diagramArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("diagram"),
  payload: Schema.Struct({ source: textSchema }),
});
const mediaArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("media"),
  payload: Schema.Struct({
    mediaType: Schema.Literals(["image", "audio", "video", "document"]),
    src: textSchema,
    alt: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  }),
});
const diffArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("diff"),
  payload: Schema.Struct({
    diff: textSchema,
    language: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  }),
});
const htmlArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("html"),
  payload: Schema.Struct({ html: textSchema }),
});
const widgetArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("widget"),
  payload: Schema.Struct({
    language: Schema.Literals(["html", "react"]),
    source: textSchema,
    brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
    generationSessionId: idSchema,
  }),
});
const fileNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(/^(?!\.{1,2}$)[^/\\]+$/),
  Schema.makeFilter((name) =>
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
      ? "File name must not contain control characters"
      : undefined,
  ),
);
const mimeTypeSchema = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
);
const base64Schema = Schema.String.check(
  Schema.isMaxLength(MAX_ARTIFACT_INPUT_BYTES),
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);
const fileArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("file"),
  payload: Schema.Struct({
    name: fileNameSchema,
    mimeType: mimeTypeSchema,
    data: base64Schema,
    byteSize: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(MAX_ARTIFACT_INPUT_BYTES),
    ),
  }).check(
    Schema.makeFilter((payload) =>
      isCanonicalBase64(payload.data) && decodedBase64ByteLength(payload.data) === payload.byteSize
        ? undefined
        : "File data must be canonical base64 matching byteSize",
    ),
  ),
});
export const cakeArtifactV1Schema = Schema.Union([
  markdownArtifactSchema,
  tableArtifactSchema,
  diagramArtifactSchema,
  mediaArtifactSchema,
  diffArtifactSchema,
  htmlArtifactSchema,
  widgetArtifactSchema,
  fileArtifactSchema,
]);
export const artifactRecordSchema = Schema.Struct({
  artifact: cakeArtifactV1Schema,
  workspacePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const artifactStableRefSchema = Schema.String.check(
  Schema.isPattern(/^cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const artifactExactRefSchema = Schema.String.check(
  Schema.isPattern(/^cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*@r[1-9][0-9]*$/),
);
const artifactPointerOriginSchema = Schema.Struct({
  assistantEntryId: provenanceIdSchema,
  toolCallId: provenanceIdSchema,
});
/** Bounded exact-revision transcript reference. Artifact payload and fallback are never included. */
export const artifactPointerSchema = Schema.Struct({
  protocol: Schema.Literal(ARTIFACT_PROTOCOL),
  lineageId: idSchema,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  // "architecture" is retained only for immutable historical reachability.
  kind: Schema.Union([artifactKindSchema, Schema.Literal("architecture")]),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  stableRef: artifactStableRefSchema,
  exactRef: artifactExactRefSchema,
  origin: Schema.optionalKey(artifactPointerOriginSchema),
}).check(
  Schema.makeFilter((pointer) =>
    pointer.stableRef === `cake://artifact/${pointer.lineageId}` &&
    pointer.exactRef === `cake://artifact/${pointer.lineageId}@r${pointer.revision}`
      ? undefined
      : "Artifact pointer references must match lineageId and revision",
  ),
);
const legacyArtifactPointerSchema = Schema.Struct({
  protocol: Schema.Literal(ARTIFACT_PROTOCOL),
  artifactId: idSchema,
  sessionId: idSchema,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Union([artifactKindSchema, Schema.Literal("architecture")]),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  fallback: Schema.Struct({ markdown: textSchema }),
  origin: Schema.optionalKey(artifactPointerOriginSchema),
});
export type CakeArtifactV1 = typeof cakeArtifactV1Schema.Type;
export type ArtifactRecord = typeof artifactRecordSchema.Type;
export type ArtifactPointer = typeof artifactPointerSchema.Type;
/** Decodes current pointers and normalizes persisted legacy pointers for reachability only. */
export function decodeArtifactPointer(input: unknown): ArtifactPointer | undefined {
  const current = Schema.decodeUnknownOption(artifactPointerSchema)(input);
  if (current._tag === "Some") return current.value;
  const legacy = Schema.decodeUnknownOption(legacyArtifactPointerSchema)(input);
  if (legacy._tag === "None") return undefined;
  const value = legacy.value;
  return Schema.decodeUnknownSync(artifactPointerSchema)({
    protocol: ARTIFACT_PROTOCOL,
    lineageId: value.artifactId,
    revision: value.revision,
    kind: value.kind,
    digest: value.digest,
    stableRef: `cake://artifact/${value.artifactId}`,
    exactRef: `cake://artifact/${value.artifactId}@r${value.revision}`,
    ...(value.origin === undefined ? null : { origin: value.origin }),
  });
}
export function parseArtifactInput(input: unknown): CakeArtifactV1 {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > MAX_ARTIFACT_INPUT_BYTES)
    throw new Error(`Artifact input exceeds the ${MAX_ARTIFACT_INPUT_BYTES}-byte limit`);
  const artifact = Schema.decodeUnknownSync(cakeArtifactV1Schema)(input);
  if (
    artifact.kind === "media" &&
    !isSafeMediaSource(artifact.payload.src, artifact.payload.mediaType)
  )
    throw new Error("Media source must be an HTTPS URL or a matching data URL");
  return artifact;
}
function decodedBase64ByteLength(value: string) {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
function isCanonicalBase64(value: string) {
  if (value.length === 0) return true;
  if (value.endsWith("==")) {
    const sextet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
      value[value.length - 3] ?? "",
    );
    return sextet >= 0 && (sextet & 0b1111) === 0;
  }
  if (value.endsWith("=")) {
    const sextet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
      value[value.length - 2] ?? "",
    );
    return sextet >= 0 && (sextet & 0b11) === 0;
  }
  return true;
}
function isSafeMediaSource(src: string, mediaType: "image" | "audio" | "video" | "document") {
  try {
    const url = new URL(src);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "data:") return false;
    const expected = mediaType === "document" ? "application/pdf" : `${mediaType}/`;
    return url.pathname.toLowerCase().startsWith(expected);
  } catch {
    return false;
  }
}
