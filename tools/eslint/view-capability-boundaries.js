import path from "node:path";
import { importPath } from "./module-boundaries.js";
import { rule } from "./ast.js";

function infrastructure(file) {
  return /^(?:src\/renderer\/(?:client(?:\/|$)|observers(?:\/|$)|runtime(?:\.|\/|$))|src\/ipc\/(?:client|protocol|transport)(?:\/|$))/.test(
    file,
  );
}

export default rule(
  "Keep runtime Client, RPC and observation infrastructure out of feature views.",
  {
    capability:
      "Feature views invoke Store intents, not runtime Client, RPC or observer infrastructure. Keep transport and activation at explicit adapters.",
  },
  (context) => {
    const relative = (file) => path.relative(context.cwd, file).split(path.sep).join("/");
    const services = context.sourceCode.parserServices;
    const checker = services?.program?.getTypeChecker();
    function origin(specifier) {
      if (!checker) return false;
      let symbol = checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(specifier.local));
      // TypeScript resolves local barrel re-exports to their defining symbol.
      if (symbol?.flags & 2097152) symbol = checker.getAliasedSymbol(symbol);
      return symbol?.declarations?.some((decl) =>
        infrastructure(relative(decl.getSourceFile().fileName)),
      );
    }
    function check(node) {
      if (!node.source || node.exportKind === "type" || node.importKind === "type") return;
      const specs = node.specifiers ?? [];
      const runtime = specs.filter(
        (spec) => spec.importKind !== "type" && spec.exportKind !== "type",
      );
      if (specs.length && !runtime.length) return;
      const target = importPath(context.filename, node.source.value, context.cwd);
      if (
        (target && infrastructure(relative(target))) ||
        runtime.some((spec) => spec.local && origin(spec))
      )
        context.report({ node, messageId: "capability" });
    }
    return {
      CallExpression(node) {
        if (!checker || node.callee.type !== "MemberExpression") return;
        const receiver = services.esTreeNodeToTSNodeMap.get(node.callee.object);
        const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
        // Broad Client/RPC capabilities passed through props are still runtime
        // infrastructure. A mapped Pick<..., "readImage"> presentation port has
        // its own type provenance and intentionally does not match this check.
        const symbol = type.aliasSymbol ?? type.getSymbol();
        if (
          symbol?.declarations?.some((decl) =>
            infrastructure(relative(decl.getSourceFile().fileName)),
          )
        )
          context.report({ node, messageId: "capability" });
      },
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression(node) {
        if (typeof node.source.value !== "string") return;
        const target = importPath(context.filename, node.source.value, context.cwd);
        if (target && infrastructure(relative(target)))
          context.report({ node, messageId: "capability" });
      },
    };
  },
);
