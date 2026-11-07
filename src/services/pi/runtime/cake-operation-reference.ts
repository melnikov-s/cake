import type { JsonObject, JsonValue } from "../../../contracts/serialization/json-contract";

/** A calling sketch, not another schema: required keys plus selected common options. */
export function compactOperationInput(
  root: JsonObject,
  commonFields: readonly string[],
  expand: readonly string[] = [],
): string {
  const object = (value: JsonValue | undefined): JsonObject | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  const resolve = (value: JsonObject): JsonObject => {
    if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) return value;
    let target: JsonValue | undefined = root;
    for (const key of value.$ref.slice(2).split("/"))
      target = object(target)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    return object(target) ?? value;
  };
  const literals = (value: JsonObject): string =>
    value.const !== undefined
      ? JSON.stringify(value.const)
      : Array.isArray(value.enum)
        ? value.enum.map((item) => JSON.stringify(item)).join("|")
        : "";
  const argumentReference = (value: JsonObject, depth: number): string => {
    if (depth > 8) return "";
    const schema = resolve(value);
    const literal = literals(schema);
    if (literal) return literal;
    if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
      const variants = (Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf) ?? [];
      if (!Array.isArray(variants)) return "";
      const parts = variants.map((item) => {
        const variant = object(item);
        return variant ? argumentReference(variant, depth + 1) : "";
      });
      return parts.every(Boolean) ? parts.join("|") : "";
    }
    if (schema.type === "array") {
      const items = object(schema.items);
      const item = items ? argumentReference(items, depth + 1) : "";
      return item ? `[${item}]` : "";
    }
    if (schema.type === "object" || schema.properties) return fields(schema, [], [], depth + 1);
    return "";
  };
  const fields = (
    schema: JsonObject,
    common: readonly string[],
    expanded: readonly string[],
    depth: number,
  ): string => {
    const properties = object(schema.properties) ?? {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const names = [...new Set([...required, ...common])].filter(
      (key): key is string => typeof key === "string" && key in properties,
    );
    return `{${names
      .map((name) => {
        const property = object(properties[name]);
        const resolved = property ? resolve(property) : undefined;
        const detail = resolved
          ? expanded.includes(name) || depth > 0
            ? argumentReference(resolved, depth + 1)
            : literals(resolved)
          : "";
        return `${name}${required.includes(name) ? "" : "?"}${detail ? `:${detail}` : ""}`;
      })
      .join(", ")}}`;
  };
  return fields(resolve(root), commonFields, expand, 0);
}
