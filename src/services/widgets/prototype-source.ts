import ts from "typescript";
import { Schema } from "effect";
import { PrototypeSource, type PrototypeModule } from "../../contracts/widgets/prototype-source";

export const prototypeModuleSpecifier = (id: string) => `cake:prototype/${id}`;

/** A structured source format, not a search for component names or source markers. */
export function readPrototypeSource(source: string): PrototypeSource | undefined {
  const file = ts.createSourceFile(
    "widget.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const statement = file.statements[0];
  if (
    file.statements.length !== 1 ||
    !statement ||
    !ts.isExportAssignment(statement) ||
    statement.isExportEquals ||
    !ts.isObjectLiteralExpression(statement.expression)
  )
    return undefined;
  // Strict JSON deliberately excludes computed expressions, spreads and executable manifests.
  let bundle: PrototypeSource;
  try {
    const value: unknown = JSON.parse(statement.expression.getText(file));
    bundle = Schema.decodeUnknownSync(PrototypeSource, { onExcessProperty: "error" })(value);
  } catch {
    // Do not leak other alternatives through decoder diagnostics at a source-read boundary.
    throw new Error(
      "Invalid prototype source manifest: expected strict cake.prototype-source/v1 JSON",
    );
  }
  const all = [bundle.chooser, ...bundle.options, ...bundle.shared];
  const modules = new Map(all.map((module) => [module.id, module]));
  if (modules.size !== all.length) throw new Error("Prototype module IDs must be unique");
  const shared = new Set(bundle.shared.map((module) => module.id));
  for (const module of all) {
    const imports = moduleImports(module);
    const dependencies = new Set(module.dependencies);
    if (
      dependencies.size !== module.dependencies.length ||
      imports.size !== dependencies.size ||
      [...imports].some((specifier) => !dependencies.has(specifier))
    )
      throw new Error(
        `Prototype ${module.id}: dependencies must exactly match static imports/exports`,
      );
    for (const specifier of dependencies) {
      if (specifier.startsWith("cake:prototype/")) {
        const id = specifier.slice("cake:prototype/".length);
        if (!modules.has(id)) throw new Error(`Missing prototype dependency: ${specifier}`);
        if (id === bundle.chooser.id || (module !== bundle.chooser && !shared.has(id)))
          throw new Error(`Prototype ${module.id} may depend only on shared modules`);
      } else if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(specifier)) {
        throw new Error(`Invalid prototype package dependency: ${specifier}`);
      }
    }
  }
  for (const option of bundle.options)
    if (!bundle.chooser.dependencies.includes(prototypeModuleSpecifier(option.id)))
      throw new Error(`Chooser must import option ${option.id}`);
  // Cycles obscure required dependency closure and are not part of this bounded format.
  const visit = (module: PrototypeModule, active: Set<string>, done: Set<string>) => {
    if (active.has(module.id)) throw new Error(`Cyclic prototype dependency: ${module.id}`);
    if (done.has(module.id)) return;
    active.add(module.id);
    for (const dependency of module.dependencies) {
      const next = modules.get(dependency.slice("cake:prototype/".length));
      if (dependency.startsWith("cake:prototype/") && next) visit(next, active, done);
    }
    active.delete(module.id);
    done.add(module.id);
  };
  const done = new Set<string>();
  for (const module of all) visit(module, new Set(), done);
  return bundle;
}

function moduleImports(module: PrototypeModule): Set<string> {
  const diagnostics =
    ts.transpileModule(module.source, {
      fileName: `${module.id}.tsx`,
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    }).diagnostics ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
    throw new Error(`Invalid prototype module syntax: ${module.id}`);
  const file = ts.createSourceFile(
    `${module.id}.tsx`,
    module.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const imports = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier) {
        if (!ts.isStringLiteral(specifier))
          throw new Error("Prototype imports must be static strings");
        imports.add(specifier.text);
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")))
    )
      throw new Error(`Prototype ${module.id}: dynamic imports/require are unsupported`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

export function selectedPrototypeModules(
  bundle: PrototypeSource,
  optionId: string,
): PrototypeModule[] {
  const option = bundle.options.find((module) => module.id === optionId);
  if (!option) throw new Error(`Unknown prototype option: ${optionId}`);
  const selected = new Map<string, PrototypeModule>();
  const visit = (module: PrototypeModule) => {
    if (selected.has(module.id)) return;
    selected.set(module.id, module);
    for (const specifier of module.dependencies) {
      if (!specifier.startsWith("cake:prototype/")) continue;
      const shared = bundle.shared.find((item) => prototypeModuleSpecifier(item.id) === specifier);
      if (!shared) throw new Error(`Missing shared prototype dependency: ${specifier}`);
      visit(shared);
    }
  };
  visit(option);
  return [...selected.values()];
}
