import { z } from "zod";

export const ARTIFACT_PROTOCOL = "cake.artifact/v1" as const;
export const MAX_ARTIFACT_INPUT_BYTES = 1_048_576;
const artifactKindSchema = z.enum(["markdown", "table", "diagram", "form", "media", "diff", "html", "widget", "request"]);
const idSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const textSchema = z.string().max(MAX_ARTIFACT_INPUT_BYTES);
const scalarSchema = z.union([z.string().max(262_144), z.number().finite(), z.boolean(), z.null()]);
export const jsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() => z.object({
  type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]).optional(),
  title: z.string().max(512).optional(),
  description: z.string().max(4_096).optional(),
  enum: z.array(scalarSchema).max(1_000).optional(),
  required: z.array(z.string().max(256)).max(1_000).optional(),
  properties: z.record(z.string().max(256), jsonSchemaSchema).optional(),
  items: jsonSchemaSchema.optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().max(MAX_ARTIFACT_INPUT_BYTES).optional()
}).strict());

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  enum?: Array<string | number | boolean | null>;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

const artifactBase = {
  protocol: z.literal(ARTIFACT_PROTOCOL),
  id: idSchema,
  sessionId: idSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z.string().max(512).optional(),
  fallback: z.object({ markdown: textSchema }),
  interaction: z.object({
    mode: z.enum(["present", "request"]),
    responseSchema: jsonSchemaSchema.optional()
  }).optional()
};

const markdownArtifactSchema = z.object({ ...artifactBase, kind: z.literal("markdown"), payload: z.object({ markdown: textSchema }) });
const tableArtifactSchema = z.object({
  ...artifactBase,
  kind: z.literal("table"),
  payload: z.object({
    columns: z.array(z.object({ id: idSchema, label: z.string().min(1).max(512), type: z.enum(["text", "number", "boolean", "date"]).default("text") })).min(1).max(100),
    rows: z.array(z.object({ id: idSchema }).catchall(scalarSchema)).max(20_000),
    selectable: z.boolean().default(false)
  })
});
const diagramArtifactSchema = z.object({ ...artifactBase, kind: z.literal("diagram"), payload: z.object({ source: textSchema }) });
const formArtifactSchema = z.object({
  ...artifactBase,
  kind: z.literal("form"),
  payload: z.object({
    fields: z.array(z.object({
      id: idSchema,
      label: z.string().min(1).max(512),
      type: z.enum(["text", "textarea", "number", "checkbox", "select"]),
      required: z.boolean().default(false),
      placeholder: z.string().max(512).optional(),
      options: z.array(z.object({ value: z.string().max(256), label: z.string().max(512) })).max(200).optional()
    })).min(1).max(200),
    submitLabel: z.string().max(128).default("Submit")
  })
});
const mediaArtifactSchema = z.object({
  ...artifactBase,
  kind: z.literal("media"),
  payload: z.object({ mediaType: z.enum(["image", "audio", "video", "document"]), src: textSchema, alt: z.string().max(2_048).optional() })
});
const diffArtifactSchema = z.object({ ...artifactBase, kind: z.literal("diff"), payload: z.object({ diff: textSchema, language: z.string().max(128).optional() }) });
const htmlArtifactSchema = z.object({ ...artifactBase, kind: z.literal("html"), payload: z.object({ html: textSchema }) });
const widgetArtifactSchema = z.object({
  ...artifactBase,
  kind: z.literal("widget"),
  payload: z.object({
    language: z.enum(["html", "react"]),
    source: textSchema,
    brief: z.string().min(1).max(262_144),
    generationSessionId: idSchema
  })
});
const requestArtifactSchema = z.object({ ...artifactBase, kind: z.literal("request"), payload: z.object({ request: z.unknown() }) });

export const cakeArtifactV1Schema = z.discriminatedUnion("kind", [
  markdownArtifactSchema,
  tableArtifactSchema,
  diagramArtifactSchema,
  formArtifactSchema,
  mediaArtifactSchema,
  diffArtifactSchema,
  htmlArtifactSchema,
  widgetArtifactSchema,
  requestArtifactSchema
]);

export const artifactRecordSchema = z.object({
  artifact: cakeArtifactV1Schema,
  workspacePath: z.string().min(1).max(4_096),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const artifactPointerSchema = z.object({
  protocol: z.literal(ARTIFACT_PROTOCOL),
  artifactId: idSchema,
  sessionId: idSchema,
  revision: z.number().int().positive(),
  kind: artifactKindSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  fallback: z.object({ markdown: textSchema })
});

export type CakeArtifactV1 = z.infer<typeof cakeArtifactV1Schema>;
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
export type ArtifactPointer = z.infer<typeof artifactPointerSchema>;

export function parseArtifactInput(input: unknown): CakeArtifactV1 {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > MAX_ARTIFACT_INPUT_BYTES) throw new Error(`Artifact input exceeds the ${MAX_ARTIFACT_INPUT_BYTES}-byte limit`);
  const artifact = cakeArtifactV1Schema.parse(input);
  if (artifact.interaction?.mode === "request" && artifact.kind !== "request") {
    throw new Error("Only request artifacts can block for a response in cake.artifact/v1");
  }
  if (artifact.kind === "media" && !isSafeMediaSource(artifact.payload.src, artifact.payload.mediaType)) {
    throw new Error("Media source must be an HTTPS URL or a matching data URL");
  }
  return artifact;
}

export function validateArtifactResponse(schema: JsonSchema | undefined, value: unknown): unknown {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_ARTIFACT_INPUT_BYTES) throw new Error("Artifact response exceeds the size limit");
  if (schema) validateJsonValue(schema, value, "$response");
  return value;
}

function validateJsonValue(schema: JsonSchema, value: unknown, path: string): void {
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) throw new Error(`${path} is not an allowed value`);
  if (schema.type === "null" && value !== null) throw new Error(`${path} must be null`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  if ((schema.type === "number" || schema.type === "integer") && (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)))) throw new Error(`${path} must be ${schema.type}`);
  if (typeof value === "number" && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${path} is outside the allowed range`);
  if (schema.type === "string" && typeof value !== "string") throw new Error(`${path} must be a string`);
  if (typeof value === "string" && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength)) throw new Error(`${path} has an invalid length`);
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.items) value.forEach((item, index) => validateJsonValue(schema.items!, item, `${path}[${index}]`));
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) throw new Error(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in record) validateJsonValue(child, record[key], `${path}.${key}`);
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
