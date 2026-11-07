import { parse, type Expression, type SpreadElement } from "acorn";
import { full } from "acorn-walk";
import { Schema } from "effect";
import { WorkflowError, WorkflowMeta } from "../../../contracts/workflows/workflow-data";
import type { JsonValue } from "../../../contracts/serialization/json-contract";

const invalid = (message: string) =>
  new WorkflowError({ operation: "parse", reason: "script", message });

/** Syntax-only decoding: generated metadata is never executed on the host. */
function literal(node: Expression | SpreadElement | null): JsonValue {
  if (node?.type === "Literal") {
    const value = node.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    const value = node.quasis[0]?.value.cooked;
    if (value !== null && value !== undefined) return value;
  }
  if (node?.type === "ArrayExpression") return node.elements.map((item) => literal(item));
  if (node?.type === "ObjectExpression") {
    const result: Record<string, JsonValue> = {};
    for (const item of node.properties) {
      if (
        item.type !== "Property" ||
        item.computed ||
        item.shorthand ||
        item.method ||
        item.kind !== "init" ||
        !(
          item.key.type === "Identifier" ||
          (item.key.type === "Literal" && typeof item.key.value === "string")
        )
      ) {
        throw invalid("Metadata must contain only literal properties.");
      }
      const key = item.key.type === "Identifier" ? item.key.name : String(item.key.value);
      Object.defineProperty(result, key, {
        value: literal(item.value),
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  throw invalid(
    "Metadata must be a plain literal object; expressions and spreads are not allowed.",
  );
}

export function parseWorkflowProgram(source: string) {
  // Acorn rejects TypeScript and malformed JavaScript without evaluating host code.
  const file = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    preserveParens: true,
  });
  const first = file.body[0];
  if (
    first?.type !== "ExportNamedDeclaration" ||
    first.declaration?.type !== "VariableDeclaration" ||
    first.declaration.kind !== "const" ||
    first.declaration.declarations.length !== 1
  ) {
    throw invalid("The first statement must be export const meta = { name, description }.");
  }
  const declaration = first.declaration.declarations[0];
  if (
    declaration?.id.type !== "Identifier" ||
    declaration.id.name !== "meta" ||
    declaration.init?.type !== "ObjectExpression"
  )
    throw invalid("Invalid workflow metadata declaration.");
  const meta = Schema.decodeUnknownSync(WorkflowMeta)(literal(declaration.init));
  full(file, (node) => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ImportExpression" ||
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source)
    ) {
      throw invalid("Workflow scripts cannot load modules.");
    }
    if (
      node !== first &&
      (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration")
    ) {
      throw invalid("Only the metadata declaration may be exported.");
    }
  });
  const end = first.end;
  return {
    meta,
    metaEnd: end,
    body: source.slice(0, end).replace(/[^\r\n]/g, " ") + source.slice(end),
  };
}
