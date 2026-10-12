import Ajv, { type ValidateFunction } from "ajv";
import { Effect, Option, Schema } from "effect";
import { WorkflowError, WorkflowOutputSchema } from "../../../../contracts/workflows/workflow-data";
import {
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../../../contracts/serialization/json-contract";

const invalidSchema = (message: string) =>
  new WorkflowError({ operation: "validateOutputSchema", reason: "invalid-input", message });

const jsonTypes = ["null", "boolean", "object", "array", "number", "integer", "string"];
const schemaTypes = (schema: JsonObject): ReadonlyArray<string> => {
  const types =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type
        : jsonTypes;
  return types.flatMap((type) =>
    typeof type === "string" ? (type === "number" ? ["number", "integer"] : [type]) : [],
  );
};
const schemaValue = (value: JsonValue | undefined): WorkflowOutputSchema | undefined => {
  const decoded = Schema.decodeUnknownOption(WorkflowOutputSchema)(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

/** Conservative proofs only: optional property constraints must not reject a satisfiable document. */
const impossible = (
  schema: WorkflowOutputSchema,
  validate: (schema: WorkflowOutputSchema) => ValidateFunction,
): boolean => {
  if (typeof schema === "boolean") return !schema;
  const conjunctions = [
    schema,
    ...(Array.isArray(schema.allOf)
      ? schema.allOf.flatMap((value) => {
          const parsed = schemaValue(value);
          return parsed === undefined ? [] : [parsed];
        })
      : []),
  ];
  if (conjunctions.some((value) => value !== schema && impossible(value, validate))) return true;
  let types = jsonTypes;
  for (const value of conjunctions)
    if (typeof value !== "boolean")
      types = types.filter((type) => schemaTypes(value).includes(type));
  if (types.length === 0) return true;
  const boundsImpossible = (minimum: string, maximum: string): boolean => {
    const minima = conjunctions.flatMap((value) =>
      typeof value !== "boolean" && typeof value[minimum] === "number" ? [value[minimum]] : [],
    );
    const maxima = conjunctions.flatMap((value) =>
      typeof value !== "boolean" && typeof value[maximum] === "number" ? [value[maximum]] : [],
    );
    return minima.length > 0 && maxima.length > 0 && Math.max(...minima) > Math.min(...maxima);
  };
  const numericBoundsImpossible = (integer: boolean): boolean => {
    const lower = conjunctions.flatMap((value) =>
      typeof value === "boolean"
        ? []
        : [
            ...(typeof value.minimum === "number"
              ? [{ value: value.minimum, exclusive: false }]
              : []),
            ...(typeof value.exclusiveMinimum === "number"
              ? [{ value: value.exclusiveMinimum, exclusive: true }]
              : []),
          ],
    );
    const upper = conjunctions.flatMap((value) =>
      typeof value === "boolean"
        ? []
        : [
            ...(typeof value.maximum === "number"
              ? [{ value: value.maximum, exclusive: false }]
              : []),
            ...(typeof value.exclusiveMaximum === "number"
              ? [{ value: value.exclusiveMaximum, exclusive: true }]
              : []),
          ],
    );
    return lower.some((minimum) =>
      upper.some((maximum) => {
        if (integer) {
          const min = minimum.exclusive ? Math.floor(minimum.value) + 1 : Math.ceil(minimum.value);
          const max = maximum.exclusive ? Math.ceil(maximum.value) - 1 : Math.floor(maximum.value);
          return min > max;
        }
        return (
          minimum.value > maximum.value ||
          (minimum.value === maximum.value && (minimum.exclusive || maximum.exclusive))
        );
      }),
    );
  };
  const allowed = types.filter((type) => {
    if (type === "number" || type === "integer")
      return !numericBoundsImpossible(type === "integer");
    if (type === "string") return !boundsImpossible("minLength", "maxLength");
    if (type === "array") return !boundsImpossible("minItems", "maxItems");
    if (type === "object") return !boundsImpossible("minProperties", "maxProperties");
    return true;
  });
  if (allowed.length === 0) return true;
  // A standalone child may refer into its root document. Such proofs are skipped,
  // not misreported as invalid references (the whole document was already compiled).
  if (
    conjunctions.some(
      (value) =>
        typeof value !== "boolean" && (value.enum !== undefined || value.const !== undefined),
    )
  ) {
    let check: ValidateFunction | undefined;
    try {
      check = validate(schema);
    } catch {
      /* Root-relative child reference. */
    }
    if (check)
      for (const value of conjunctions) {
        if (typeof value === "boolean") continue;
        if (Array.isArray(value.enum) && !value.enum.some((candidate) => check(candidate)))
          return true;
        if (value.const !== undefined && !check(value.const)) return true;
      }
  }
  for (const union of [schema.anyOf, schema.oneOf])
    if (
      Array.isArray(union) &&
      union.every((value) => {
        const parsed = schemaValue(value);
        return parsed !== undefined && impossible(parsed, validate);
      })
    )
      return true;
  if (allowed.every((type) => type === "object") && Array.isArray(schema.required)) {
    const properties = schemaValue(schema.properties);
    for (const key of schema.required) {
      if (typeof key !== "string") continue;
      const property =
        properties && typeof properties !== "boolean" ? schemaValue(properties[key]) : undefined;
      if (property !== undefined && impossible(property, validate)) return true;
      if (
        schema.additionalProperties === false &&
        property === undefined &&
        schema.patternProperties === undefined
      )
        return true;
    }
  }
  return false;
};

export const compileOutputSchema = Effect.fn("WorkflowWorkers.compileOutputSchema")(function* (
  schema: WorkflowOutputSchema,
) {
  const decoded = yield* Schema.decodeUnknownEffect(WorkflowOutputSchema)(schema).pipe(
    Effect.mapError((error) => invalidSchema(error.message)),
  );
  return yield* Effect.try({
    try: () => {
      // No mutation/coercion, no remote reference loading, and no validator cache shared between runs.
      const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: true });
      const validate = ajv.compile(decoded);
      if (impossible(decoded, (value) => ajv.compile(value)))
        throw new Error("Output schema is provably contradictory");
      return validate;
    },
    catch: (error) => invalidSchema(error instanceof Error ? error.message : String(error)),
  });
});

export const validateAnswer = Effect.fn("WorkflowWorkers.validateAnswer")(function* (
  text: string,
  validate: ValidateFunction,
) {
  const fail = (message: string) =>
    new WorkflowError({ operation: "answer", reason: "invalid-output", message });
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(jsonValueSchema))(
    text,
  ).pipe(
    Effect.mapError((error) =>
      fail(`Answer must be one JSON value with no Markdown or commentary: ${error.message}`),
    ),
  );
  if (!validate(decoded)) return yield* fail(JSON.stringify(validate.errors).slice(0, 4_096));
  return decoded;
});
