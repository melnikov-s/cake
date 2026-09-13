import { Predicate, Schema } from "effect";
import { jsonValueSchema, type JsonValue } from "./json-contract";
import { sourceLocationSchema } from "./source-location";

const ARTIFACT_PROTOCOL = "cake.artifact/v1" as const;
export const MAX_ARTIFACT_INPUT_BYTES = 1_048_576;
const artifactKindSchema = Schema.Literals([
  "markdown",
  "table",
  "diagram",
  "architecture",
  "form",
  "media",
  "diff",
  "html",
  "widget",
  "request",
]);
const idSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const textSchema = Schema.String.check(Schema.isMaxLength(MAX_ARTIFACT_INPUT_BYTES));
const scalarSchema = Schema.Union([
  Schema.String.check(Schema.isMaxLength(262_144)),
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  Schema.Null,
]);

export interface JsonSchema {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly title?: string;
  readonly description?: string;
  readonly enum?: ReadonlyArray<string | number | boolean | null>;
  readonly required?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export const jsonSchemaSchema: Schema.Codec<JsonSchema> = Schema.suspend(() =>
  Schema.Struct({
    type: Schema.optional(
      Schema.Literals(["object", "array", "string", "number", "integer", "boolean", "null"]),
    ),
    title: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
    description: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
    enum: Schema.optional(Schema.Array(scalarSchema).check(Schema.isMaxLength(1_000))),
    required: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(1_000)),
    ),
    properties: Schema.optional(
      Schema.Record(Schema.String.check(Schema.isMaxLength(256)), jsonSchemaSchema),
    ),
    items: Schema.optional(jsonSchemaSchema),
    minimum: Schema.optional(Schema.Number.check(Schema.isFinite())),
    maximum: Schema.optional(Schema.Number.check(Schema.isFinite())),
    minLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    maxLength: Schema.optional(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(MAX_ARTIFACT_INPUT_BYTES),
      ),
    ),
  }),
);

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
  interaction: Schema.optional(
    Schema.Struct({
      mode: Schema.Literals(["present", "request"]),
      responseSchema: Schema.optional(jsonSchemaSchema),
    }),
  ),
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

const architectureNodeCategorySchema = Schema.Literals([
  "interface",
  "service",
  "process",
  "database",
  "external",
  "module",
]);

export const architectureGraphSchema = Schema.Struct({
  direction: Schema.optional(Schema.Literals(["LR", "TB", "RL", "BT"])),
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: idSchema,
        label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }),
    ).check(Schema.isMaxLength(50)),
  ),
  nodes: Schema.Array(
    Schema.Struct({
      id: idSchema,
      label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      description: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
      category: Schema.optional(architectureNodeCategorySchema),
      group: Schema.optional(idSchema),
      source: Schema.optional(sourceLocationSchema),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(250)),
  edges: Schema.Array(
    Schema.Struct({
      id: idSchema,
      source: idSchema,
      target: idSchema,
      label: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
      kind: Schema.optional(Schema.Literals(["data", "control", "dependency", "event"])),
    }),
  ).check(Schema.isMaxLength(500)),
});

const architectureArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("architecture"),
  payload: architectureGraphSchema,
});
const formArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("form"),
  payload: Schema.Struct({
    fields: Schema.Array(
      Schema.Struct({
        id: idSchema,
        label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
        type: Schema.Literals(["text", "textarea", "number", "checkbox", "select"]),
        placeholder: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
        options: Schema.optional(
          Schema.Array(
            Schema.Struct({
              value: Schema.String.check(Schema.isMaxLength(256)),
              label: Schema.String.check(Schema.isMaxLength(512)),
            }),
          ).check(Schema.isMaxLength(200)),
        ),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
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
const requestArtifactSchema = Schema.Struct({
  ...artifactBase,
  kind: Schema.Literal("request"),
  payload: Schema.Struct({ request: Schema.Unknown }),
});

const cakeArtifactV1Schema = Schema.Union([
  markdownArtifactSchema,
  tableArtifactSchema,
  diagramArtifactSchema,
  architectureArtifactSchema,
  formArtifactSchema,
  mediaArtifactSchema,
  diffArtifactSchema,
  htmlArtifactSchema,
  widgetArtifactSchema,
  requestArtifactSchema,
]);

export const artifactRecordSchema = Schema.Struct({
  artifact: cakeArtifactV1Schema,
  workspacePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const artifactPointerSchema = Schema.Struct({
  protocol: Schema.Literal(ARTIFACT_PROTOCOL),
  artifactId: idSchema,
  sessionId: idSchema,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: artifactKindSchema,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  fallback: Schema.Struct({ markdown: textSchema }),
  origin: Schema.optionalKey(
    Schema.Struct({
      assistantEntryId: idSchema,
      toolCallId: idSchema,
    }),
  ),
});

export type CakeArtifactV1 = typeof cakeArtifactV1Schema.Type;
export type ArtifactRecord = typeof artifactRecordSchema.Type;
export type ArtifactPointer = typeof artifactPointerSchema.Type;

export function parseArtifactInput(input: unknown): CakeArtifactV1 {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > MAX_ARTIFACT_INPUT_BYTES)
    throw new Error(`Artifact input exceeds the ${MAX_ARTIFACT_INPUT_BYTES}-byte limit`);
  const artifact = Schema.decodeUnknownSync(cakeArtifactV1Schema)(input);
  if (artifact.interaction?.mode === "request" && artifact.kind !== "request")
    throw new Error("Only request artifacts can block for a response in cake.artifact/v1");
  if (artifact.kind === "architecture") validateArchitectureGraph(artifact.payload);
  if (
    artifact.kind === "media" &&
    !isSafeMediaSource(artifact.payload.src, artifact.payload.mediaType)
  )
    throw new Error("Media source must be an HTTPS URL or a matching data URL");
  return artifact;
}

export function validateArtifactResponse(
  schema: JsonSchema | undefined,
  value: JsonValue | undefined,
): JsonValue | undefined {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_ARTIFACT_INPUT_BYTES)
    throw new Error("Artifact response exceeds the size limit");
  const parsedValue =
    value === undefined ? undefined : Schema.decodeUnknownSync(jsonValueSchema)(value);
  if (schema) validateJsonValue(schema, parsedValue, "$response");
  return parsedValue;
}

function validateJsonValue(schema: JsonSchema, value: JsonValue | undefined, path: string): void {
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value)))
    throw new Error(`${path} is not an allowed value`);
  if (schema.type === "null" && value !== null) throw new Error(`${path} must be null`);
  if (schema.type === "boolean" && typeof value !== "boolean")
    throw new Error(`${path} must be a boolean`);
  if (
    (schema.type === "number" || schema.type === "integer") &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value)))
  )
    throw new Error(`${path} must be ${schema.type}`);
  if (
    typeof value === "number" &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw new Error(`${path} is outside the allowed range`);
  if (schema.type === "string" && typeof value !== "string")
    throw new Error(`${path} must be a string`);
  if (
    typeof value === "string" &&
    ((schema.minLength !== undefined && value.length < schema.minLength) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength))
  )
    throw new Error(`${path} has an invalid length`);
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.items)
      value.forEach((item, index) => validateJsonValue(schema.items!, item, `${path}[${index}]`));
  }
  if (schema.type === "object") {
    if (!Predicate.isObject(value) || Array.isArray(value))
      throw new Error(`${path} must be an object`);
    for (const key of schema.required ?? [])
      if (!(key in value)) throw new Error(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (key in value)
        validateJsonValue(
          child,
          Schema.decodeUnknownSync(jsonValueSchema)(value[key]),
          `${path}.${key}`,
        );
  }
}

function validateArchitectureGraph(graph: typeof architectureGraphSchema.Type) {
  const groupIds = new Set<string>();
  for (const group of graph.groups ?? []) {
    if (groupIds.has(group.id)) throw new Error(`Duplicate architecture group ID: ${group.id}`);
    groupIds.add(group.id);
  }
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Duplicate architecture node ID: ${node.id}`);
    if (groupIds.has(node.id))
      throw new Error(`Architecture node and group IDs must be distinct: ${node.id}`);
    if (node.group && !groupIds.has(node.group))
      throw new Error(`Architecture node ${node.id} references unknown group ${node.group}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate architecture edge ID: ${edge.id}`);
    if (!nodeIds.has(edge.source))
      throw new Error(`Architecture edge ${edge.id} references unknown source ${edge.source}`);
    if (!nodeIds.has(edge.target))
      throw new Error(`Architecture edge ${edge.id} references unknown target ${edge.target}`);
    edgeIds.add(edge.id);
  }
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
