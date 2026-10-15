import type { JsonObject, JsonValue } from "../../../contracts/serialization/json-contract";

/**
 * Agents routinely guess the assignment or reference field of a Cake operation from a
 * neighbouring one: subagents.start takes `task`, sessions.create `initialPrompt`,
 * sessions.send `text`, session.fork `prompt`; attachments.read takes `reference` while
 * messages.read takes `ref`. Each group lists names that mean the same thing. A name from a
 * group is accepted as an alias only when the operation declares exactly one member of that
 * group, so a rename is never ambiguous and a declared field is never reinterpreted.
 */
const aliasGroups: ReadonlyArray<ReadonlyArray<string>> = [
  ["initialPrompt", "prompt", "task", "text", "message"],
  ["reference", "ref", "id"],
  ["name", "title"],
];

interface InputContract {
  readonly properties: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
  /** Unknown keys are rejected; only closed objects get alias and unknown-field handling. */
  readonly closed: boolean;
}

function inputContract(schema: JsonObject): InputContract | undefined {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties))
    return undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  return {
    properties: new Set(Object.keys(properties)),
    required: new Set(required),
    closed: schema.additionalProperties === false,
  };
}

/** alias → canonical field for one operation input schema. */
function cakeOperationInputAliases(schema: JsonObject): ReadonlyMap<string, string> {
  const contract = inputContract(schema);
  const aliases = new Map<string, string>();
  if (!contract?.closed) return aliases;
  for (const group of aliasGroups) {
    const declared = group.filter((field) => contract.properties.has(field));
    if (declared.length !== 1) continue;
    for (const alias of group) if (alias !== declared[0]) aliases.set(alias, declared[0]!);
  }
  return aliases;
}

/** One help line naming accepted aliases, or undefined when the operation has none. */
export function cakeOperationAliasHelp(schema: JsonObject): string | undefined {
  const byField = new Map<string, string[]>();
  for (const [alias, field] of cakeOperationInputAliases(schema))
    byField.set(field, [...(byField.get(field) ?? []), alias]);
  if (byField.size === 0) return undefined;
  return [...byField]
    .map(([field, aliases]) => `${field} (also accepted as ${aliases.join(", ")})`)
    .join("; ");
}

/** "a (required), b" for error messages. */
export function cakeOperationExpectedFields(schema: JsonObject): string | undefined {
  const contract = inputContract(schema);
  if (!contract || contract.properties.size === 0) return undefined;
  return [...contract.properties]
    .map((field) => (contract.required.has(field) ? `${field} (required)` : field))
    .join(", ");
}

/**
 * Rename unambiguous aliases to their declared field, and reject unknown fields of closed
 * inputs with a message naming the expected fields instead of a bare schema error.
 */
export function normalizeCakeOperationInput(
  command: string,
  input: JsonObject,
  schema: JsonObject,
): JsonObject {
  const contract = inputContract(schema);
  if (!contract?.closed) return input;
  const aliases = cakeOperationInputAliases(schema);
  const normalized: Record<string, JsonValue> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (contract.properties.has(key)) {
      normalized[key] = value;
      continue;
    }
    const field = aliases.get(key);
    if (field === undefined) {
      unknown.push(key);
      continue;
    }
    if (field in input || Object.hasOwn(normalized, field))
      throw new Error(
        `${command} received both "${key}" and "${field}". Use only "${field}"; "${key}" is an alias for it.`,
      );
    normalized[field] = value;
  }
  if (unknown.length > 0) {
    const fields = cakeOperationExpectedFields(schema);
    throw new Error(
      [
        `${command} does not accept input field${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `"${key}"`).join(", ")}.`,
        ...(fields ? [`Expected fields: ${fields}.`] : []),
        `Request {"command":"${command}.help"} for the exact schema.`,
      ].join(" "),
    );
  }
  return normalized;
}
