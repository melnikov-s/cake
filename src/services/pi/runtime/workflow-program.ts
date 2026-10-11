import ts from "typescript";
import { parse } from "acorn";
import { Schema } from "effect";
import { WorkflowError, WorkflowMeta } from "../../../contracts/workflows/workflow-data";
import type { JsonValue } from "../../../ipc/json-contract";

const invalid = (message: string) =>
  new WorkflowError({ operation: "parse", reason: "script", message });

/** Syntax-only decoding: generated metadata is never executed on the host. */
function literal(node: ts.Expression): JsonValue {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => literal(item));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, JsonValue> = {};
    for (const item of node.properties) {
      if (
        !ts.isPropertyAssignment(item) ||
        !item.name ||
        !(ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
      ) {
        throw invalid("Metadata must contain only literal properties.");
      }
      Object.defineProperty(result, item.name.text, {
        value: literal(item.initializer),
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
  const file = ts.createSourceFile(
    "workflow.js",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  // Acorn rejects TypeScript and malformed JavaScript without evaluating host code.
  parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
  const first = file.statements[0];
  if (
    !first ||
    !ts.isVariableStatement(first) ||
    !first.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) ||
    !(first.declarationList.flags & ts.NodeFlags.Const) ||
    first.declarationList.declarations.length !== 1
  ) {
    throw invalid("The first statement must be export const meta = { name, description }.");
  }
  const declaration = first.declarationList.declarations[0];
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== "meta" ||
    !declaration.initializer ||
    !ts.isObjectLiteralExpression(declaration.initializer)
  )
    throw invalid("Invalid workflow metadata declaration.");
  const meta = Schema.decodeUnknownSync(WorkflowMeta)(literal(declaration.initializer));
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      throw invalid("Workflow scripts cannot load modules.");
    }
    if (
      node !== first &&
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      throw invalid("Only the metadata declaration may be exported.");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const end = first.end;
  return {
    meta,
    metaEnd: end,
    body: source.slice(0, end).replace(/[^\r\n]/g, " ") + source.slice(end),
  };
}
