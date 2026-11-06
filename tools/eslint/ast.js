// Shared lexical helpers. Resolve bindings, not names, so aliases work and
// locally shadowed framework functions are not mistaken for imports/globals.
export function variable(context, node) {
  if (node?.type !== "Identifier") return undefined;
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const found = scope.set.get(node.name);
    if (found) return found;
    scope = scope.upper;
  }
}

export function imported(context, node, source, name) {
  if (node?.type === "Identifier") {
    return variable(context, node)?.defs.some(
      (def) =>
        def.type === "ImportBinding" &&
        def.parent.source.value === source &&
        def.node.type === "ImportSpecifier" &&
        (def.node.imported.name ?? def.node.imported.value) === name,
    );
  }
  if (node?.type === "MemberExpression" && !node.computed && node.object.type === "Identifier") {
    return (
      node.property.name === name &&
      variable(context, node.object)?.defs.some(
        (def) =>
          def.type === "ImportBinding" &&
          def.parent.source.value === source &&
          (def.node.type === "ImportNamespaceSpecifier" ||
            def.node.type === "ImportDefaultSpecifier"),
      )
    );
  }
  return false;
}

export function effectApi(context, node, name) {
  return (
    imported(context, node, "effect/Effect", name) ||
    (node?.type === "MemberExpression" &&
      !node.computed &&
      node.property.name === name &&
      imported(context, node.object, "effect", "Effect"))
  );
}

export function globalReference(context, node, names) {
  return (
    node?.type === "Identifier" &&
    names.includes(node.name) &&
    !variable(context, node)?.defs.length
  );
}

export function walk(context, node, visit, skipFunctions = false) {
  if (!node) return;
  visit(node);
  for (const key of context.sourceCode.visitorKeys[node.type] ?? []) {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    for (const child of children) {
      if (!child?.type) continue;
      if (skipFunctions && /FunctionExpression|FunctionDeclaration/.test(child.type)) continue;
      walk(context, child, visit, skipFunctions);
    }
  }
}

export function unwrap(node) {
  while (
    ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ChainExpression"].includes(
      node?.type,
    )
  )
    node = node.expression;
  return node;
}

export function rule(description, messages, create, schema = []) {
  return { meta: { type: "suggestion", docs: { description }, schema, messages }, create };
}
