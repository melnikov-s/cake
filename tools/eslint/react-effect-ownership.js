import { imported, rule, variable, walk } from "./ast.js";

function storeType(type, checker, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection?.())
    return type.types.some((part) => storeType(part, checker, seen));
  const symbol = type.getSymbol();
  if (
    symbol?.declarations?.some(
      (decl) =>
        decl.name?.text === "Store" &&
        /[/\\]r-state-tree[/\\].*[/\\]Store\.d\.ts$/.test(decl.getSourceFile().fileName),
    )
  )
    return true;
  return type.getBaseTypes?.()?.some((base) => storeType(base, checker, seen)) ?? false;
}

export default rule(
  "Keep provable Store activation and synchronous state copies out of React effect setup.",
  {
    workflow:
      "This Effect starts a Store workflow. Let its Store own activation, cancellation, and repeated-call policy.",
    copy: "This Effect synchronously copies state. Derive the value during render or in a Store getter, unless this reconciles an editable draft or DOM integration.",
  },
  (context) => {
    const services = context.sourceCode.parserServices;
    const checker = services?.program?.getTypeChecker();
    function isWorkflow(node) {
      if (!checker || node.callee.type !== "MemberExpression") return false;
      const receiver = services.esTreeNodeToTSNodeMap.get(node.callee.object);
      const type = checker.getTypeAtLocation(receiver);
      if (!storeType(type, checker)) return false;
      const member = node.callee.computed ? node.callee.property.value : node.callee.property.name;
      if (context.options[0]?.workflowExceptions?.includes(`${type.getSymbol()?.name}.${member}`))
        return false;
      const signature = checker.getResolvedSignature(services.esTreeNodeToTSNodeMap.get(node));
      return (
        signature && !!checker.getPromisedTypeOfPromise(checker.getReturnTypeOfSignature(signature))
      );
    }
    function stateSetter(node) {
      const binding = variable(context, node);
      return binding?.defs.some((def) => {
        const id = def.node.id;
        return (
          id?.type === "ArrayPattern" &&
          id.elements[1] === def.name &&
          def.node.init?.type === "CallExpression" &&
          imported(context, def.node.init.callee, "react", "useState")
        );
      });
    }
    return {
      CallExpression(node) {
        if (
          !["useEffect", "useLayoutEffect"].some((name) =>
            imported(context, node.callee, "react", name),
          )
        )
          return;
        const setup = node.arguments[0];
        if (!["ArrowFunctionExpression", "FunctionExpression"].includes(setup?.type)) return;
        // Do not follow event handlers, observer callbacks, Promise continuations,
        // cleanup functions or unknown helper calls. These are not immediate setup.
        walk(
          context,
          setup.body,
          (call) => {
            if (call.type !== "CallExpression") return;
            if (isWorkflow(call)) context.report({ node: call, messageId: "workflow" });
            if (
              context.options[0]?.stateCopyExceptions?.includes(call.callee.name) ||
              !stateSetter(call.callee) ||
              call.arguments.length !== 1
            )
              return;
            const value = call.arguments[0];
            if (!["Identifier", "MemberExpression"].includes(value.type)) return;
            const dependencies = node.arguments[1];
            // Only a direct copy of a declared dependency is provable here. Calls
            // such as getBoundingClientRect(), transforms and updater functions stay valid.
            if (
              dependencies?.type === "ArrayExpression" &&
              dependencies.elements.some(
                (dep) =>
                  dep && context.sourceCode.getText(dep) === context.sourceCode.getText(value),
              )
            )
              context.report({ node: call, messageId: "copy" });
          },
          true,
        );
      },
    };
  },
  [
    {
      type: "object",
      properties: {
        stateCopyExceptions: { type: "array", items: { type: "string" }, uniqueItems: true },
        workflowExceptions: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
      additionalProperties: false,
    },
  ],
);
