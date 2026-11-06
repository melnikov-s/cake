// Reusable r-state-tree rule: deliberately no Cake paths or Store naming assumptions.
import { globalReference, imported, rule, unwrap, walk } from "./ast.js";

const mutators = {
  array: new Set([
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
    "sort",
    "reverse",
    "fill",
    "copyWithin",
  ]),
  Map: new Set(["set", "delete", "clear"]),
  Set: new Set(["add", "delete", "clear"]),
};
function fieldName(node) {
  return node?.type === "MemberExpression" && node.object.type === "ThisExpression"
    ? node.computed
      ? typeof node.property.value === "string"
        ? node.property.value
        : undefined
      : node.property.name
    : undefined;
}
function container(context, value) {
  value = unwrap(value);
  if (value?.type === "ArrayExpression") return "array";
  if (value?.type === "ObjectExpression") return "object";
  if (value?.type === "NewExpression" && globalReference(context, value.callee, ["Map", "Set"]))
    return value.callee.name;
}
function plainCopy(context, value) {
  value = unwrap(value);
  return (
    container(context, value) ||
    (value?.type === "CallExpression" &&
      value.callee.type === "MemberExpression" &&
      ["slice", "filter", "map", "concat", "toSorted", "toReversed", "toSpliced", "with"].includes(
        value.callee.property.name,
      ) &&
      fieldName(value.callee.object))
  );
}

export default rule(
  "Preserve proven collection tracking on same-class r-state-tree fields.",
  {
    replace:
      "Replacing observable field {{field}} with a plain container loses structural tracking. Mutate the existing container.",
    mutate:
      "Mutating plain field {{field}} in place does not notify observers. Wrap it or reassign the field.",
  },
  (context) => {
    const classes = [];
    function current(node) {
      // An ordinary method's this belongs to the class. Nested functions may
      // have another this; only arrow functions preserve it.
      for (
        let parent = node.parent;
        parent && parent !== classes.at(-1)?.node;
        parent = parent.parent
      ) {
        if (parent.type === "FunctionExpression" && parent.parent.type !== "MethodDefinition")
          return undefined;
        if (parent.type === "MethodDefinition" && (parent.kind === "constructor" || parent.static))
          return undefined;
      }
      return classes.at(-1);
    }
    function check(node, member, replacement) {
      const owner = current(node);
      const name = fieldName(member);
      const info = owner?.fields.get(name);
      if (
        !info ||
        context.options[0]?.nonReactiveFields?.includes(`${owner.node.id?.name}.${name}`)
      )
        return;
      if (replacement && info.reactive && plainCopy(context, node.right))
        context.report({ node, messageId: "replace", data: { field: name } });
      if (!replacement && !info.reactive)
        context.report({ node, messageId: "mutate", data: { field: name } });
    }
    return {
      ClassBody(node) {
        const parent = node.parent;
        const superClass = parent.superClass;
        const base =
          superClass?.type === "TSInstantiationExpression" ? superClass.expression : superClass;
        const supported = ["Store", "Model"].some((name) =>
          imported(context, base, "r-state-tree", name),
        );
        const fields = new Map();
        if (supported)
          for (const field of node.body) {
            if (
              field.type !== "PropertyDefinition" ||
              field.static ||
              field.computed ||
              field.key.type !== "Identifier"
            )
              continue;
            // @child arrays are managed by the library, including reassignment;
            // they must not be confused with raw snapshot arrays.
            if (
              field.decorators?.some((d) =>
                imported(
                  context,
                  d.expression.type === "CallExpression" ? d.expression.callee : d.expression,
                  "r-state-tree",
                  "child",
                ),
              )
            )
              continue;
            const value = unwrap(field.value);
            const reactive =
              value?.type === "CallExpression" &&
              ["observable", "toObservableTree"].some((name) =>
                imported(context, value.callee, "r-state-tree", name),
              );
            const kind = container(context, reactive ? value.arguments[0] : value);
            if (kind) {
              // A private buffer is not necessarily presentation state. Require a
              // same-class getter read before diagnosing private plain containers.
              // Private fields that feed getters are still checked, not exempted.
              let exposed = field.accessibility !== "private";
              if (!reactive && !exposed)
                for (const method of node.body) {
                  if (method.type === "MethodDefinition" && method.kind === "get")
                    walk(
                      context,
                      method.value.body,
                      (read) => {
                        if (fieldName(read) === field.key.name) exposed = true;
                      },
                      true,
                    );
                }
              if (reactive || exposed) fields.set(field.key.name, { reactive, kind });
            }
          }
        // Do not assume a raw initializer stays raw after a helper or wrapper
        // assignment. Unknown provenance is a deliberate false negative.
        walk(context, node, (assignment) => {
          if (assignment.type !== "AssignmentExpression") return;
          const name = fieldName(assignment.left);
          if (
            fields.has(name) &&
            !fields.get(name).reactive &&
            !plainCopy(context, assignment.right)
          )
            fields.delete(name);
        });
        classes.push({ node: parent, fields });
      },
      "ClassBody:exit"() {
        classes.pop();
      },
      AssignmentExpression(node) {
        if (fieldName(node.left)) check(node, node.left, true);
        else if (node.left.type === "MemberExpression" && fieldName(node.left.object))
          check(node, node.left.object, false);
      },
      UpdateExpression(node) {
        if (node.argument.type === "MemberExpression") check(node, node.argument.object, false);
      },
      UnaryExpression(node) {
        if (node.operator === "delete" && node.argument.type === "MemberExpression")
          check(node, node.argument.object, false);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const info = current(node)?.fields.get(fieldName(callee.object));
        if (info && mutators[info.kind]?.has(callee.property.name))
          check(node, callee.object, false);
      },
    };
  },
  [
    {
      type: "object",
      properties: {
        nonReactiveFields: { type: "array", items: { type: "string" }, uniqueItems: true },
      },
      additionalProperties: false,
    },
  ],
);
