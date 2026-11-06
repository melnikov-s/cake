import { globalReference, imported, rule, variable, walk } from "./ast.js";

function playwrightPage(context, node, seen = new Set()) {
  if (node?.type !== "Identifier") return false;
  const binding = variable(context, node);
  if (!binding || seen.has(binding)) return false;
  seen.add(binding);
  return binding.defs.some((def) => {
    const annotation = def.name?.typeAnnotation?.typeAnnotation;
    if (
      annotation?.type === "TSTypeReference" &&
      ["@playwright/test", "playwright", "playwright-core"].some((source) =>
        imported(context, annotation.typeName, source, "Page"),
      )
    )
      return true;
    if (def.type === "Variable" && def.node.init)
      return playwrightPage(context, def.node.init, seen);
    if (def.type !== "Parameter") return false;
    const pattern = def.name.parent;
    if (
      pattern?.type !== "Property" ||
      pattern.key.name !== "page" ||
      pattern.parent.type !== "ObjectPattern"
    )
      return false;
    const fn = def.node;
    const call = fn.parent;
    return (
      call?.type === "CallExpression" && imported(context, call.callee, "@playwright/test", "test")
    );
  });
}

export default rule(
  "Prefer observable completion and controlled clocks to arbitrary test delays.",
  {
    wait: "Wait for an observable condition or advance a controlled clock instead of an elapsed-time delay. Document intentional real-time integration behavior with a narrow rule suppression.",
  },
  (context) => ({
    NewExpression(node) {
      if (!globalReference(context, node.callee, ["Promise"])) return;
      const executor = node.arguments[0];
      if (
        !["ArrowFunctionExpression", "FunctionExpression"].includes(executor?.type) ||
        executor.params[0]?.type !== "Identifier"
      )
        return;
      const resolve = variable(context, executor.params[0]);
      walk(
        context,
        executor.body,
        (call) => {
          if (
            call.type !== "CallExpression" ||
            !globalReference(context, call.callee, ["setTimeout"])
          )
            return;
          const callback = call.arguments[0];
          // Only Promise-as-sleep: no real asynchronous callback under test.
          if (callback?.type === "Identifier" && variable(context, callback) === resolve)
            context.report({ node: call, messageId: "wait" });
          if (["ArrowFunctionExpression", "FunctionExpression"].includes(callback?.type)) {
            const body = callback.body;
            const invocation =
              body.type === "BlockStatement" &&
              body.body.length === 1 &&
              body.body[0].type === "ExpressionStatement"
                ? body.body[0].expression
                : body;
            if (
              invocation?.type === "CallExpression" &&
              invocation.arguments.length === 0 &&
              variable(context, invocation.callee) === resolve
            )
              context.report({ node: call, messageId: "wait" });
          }
        },
        true,
      );
    },
    CallExpression(node) {
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property.name === "waitForTimeout" &&
        playwrightPage(context, node.callee.object)
      )
        context.report({ node, messageId: "wait" });
    },
  }),
);
