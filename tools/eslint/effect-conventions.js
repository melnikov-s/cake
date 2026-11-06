import { effectApi, globalReference, rule } from "./ast.js";

function exportedFunctions(program) {
  const exports = new Set();
  for (const statement of program.body) {
    if (
      statement.type === "ExportDefaultDeclaration" &&
      /Function/.test(statement.declaration.type)
    )
      exports.add(statement.declaration);
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration) exports.add(statement.declaration);
    if (!statement.source)
      for (const specifier of statement.specifiers) exports.add(specifier.local.name);
  }
  const functions = [];
  for (const statement of program.body) {
    const declaration = statement.declaration ?? statement;
    if (
      declaration.type === "FunctionDeclaration" &&
      (exports.has(declaration) || exports.has(declaration.id?.name))
    )
      functions.push(declaration);
    if (
      exports.has(declaration) &&
      ["ArrowFunctionExpression", "FunctionExpression"].includes(declaration.type)
    )
      functions.push(declaration);
    if (declaration.type === "VariableDeclaration")
      for (const entry of declaration.declarations) {
        if (
          (exports.has(declaration) || exports.has(entry.id.name)) &&
          ["ArrowFunctionExpression", "FunctionExpression"].includes(entry.init?.type)
        )
          functions.push(entry.init);
      }
  }
  return functions;
}

export const nativeOrchestration = rule(
  "Keep exported domain orchestration in Effects and native timers at adapters.",
  {
    boundary:
      "Backend domain orchestration should compose named Effects. Keep Promise APIs and native timers at explicit adapters.",
  },
  (context) => ({
    Program(node) {
      for (const fn of exportedFunctions(node))
        if (fn.async) context.report({ node: fn, messageId: "boundary" });
    },
    CallExpression(node) {
      const callee = node.callee;
      const timer =
        globalReference(context, callee, ["setTimeout", "setInterval"]) ||
        (callee.type === "MemberExpression" &&
          !callee.computed &&
          globalReference(context, callee.object, ["globalThis"]) &&
          ["setTimeout", "setInterval"].includes(callee.property.name));
      if (timer) context.report({ node, messageId: "boundary" });
    },
  }),
);

export const causeRecovery = rule(
  "Review cause-level recovery outside explicit runtime/supervision boundaries.",
  {
    cause:
      "Review cause-level recovery at an explicit supervision boundary. Prefer typed catchTag recovery and preserve interruption; best-effort fallback is not automatically a critical defect.",
  },
  (context) => ({
    CallExpression(node) {
      if (
        ["catchCause", "catchCauseIf", "catchCauseFilter", "catchDefect"].some((name) =>
          effectApi(context, node.callee, name),
        )
      )
        context.report({ node, messageId: "cause" });
    },
  }),
);

export const namedOperations = rule(
  "Name exported Effect.gen operation wrappers with Effect.fn.",
  {
    named:
      'Define this exported Effect operation with Effect.fn("Module.operation") for a named trace.',
  },
  (context) => ({
    Program(node) {
      for (const fn of exportedFunctions(node)) {
        // Generic adapters cannot always preserve their signatures with fn.
        if (fn.typeParameters) continue;
        const body = fn.body;
        const result =
          body.type === "BlockStatement"
            ? body.body.length === 1 && body.body[0].type === "ReturnStatement"
              ? body.body[0].argument
              : undefined
            : body;
        if (result?.type === "CallExpression" && effectApi(context, result.callee, "gen"))
          context.report({ node: fn, messageId: "named" });
      }
    },
  }),
);
