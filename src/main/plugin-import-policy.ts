import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const pluginSharedModules = new Set([
  "cake",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "zod",
]);

export interface ValidatePluginImportOptions {
  pluginRoot: string;
  importer: string;
  specifier: string;
  /** The final filesystem path selected by the bundler, when available. */
  resolvedPath?: string;
}

export type ValidatedPluginImport =
  | { kind: "shared"; specifier: string }
  | { kind: "local"; path: string };

export class PluginImportPolicyError extends Error {
  constructor(
    readonly importer: string,
    readonly specifier: string,
    reason: string,
  ) {
    super(`${importer}: rejected plugin import ${JSON.stringify(specifier)}: ${reason}`);
    this.name = "PluginImportPolicyError";
  }
}

function isWithin(root: string, path: string) {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

/**
 * Enforces Cake's plugin module boundary both before and after bundler
 * resolution. The post-resolution realpath check closes symlink escapes.
 */
export async function validatePluginImport(
  options: ValidatePluginImportOptions,
): Promise<ValidatedPluginImport> {
  const { importer, specifier } = options;
  if (specifier.includes("\0"))
    throw new PluginImportPolicyError(
      importer,
      specifier,
      "NUL bytes are not valid module specifiers",
    );
  const root = await realpath(options.pluginRoot);
  const actualImporter = await realpath(importer);
  if (!isWithin(root, actualImporter)) {
    throw new PluginImportPolicyError(
      importer,
      specifier,
      "the importing file is outside its plugin directory",
    );
  }
  if (pluginSharedModules.has(specifier)) return { kind: "shared", specifier };
  if (isAbsolute(specifier))
    throw new PluginImportPolicyError(
      importer,
      specifier,
      "absolute filesystem imports are not allowed",
    );
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new PluginImportPolicyError(
      importer,
      specifier,
      "bare module is not on Cake's allowlist",
    );
  }

  const unresolved = resolve(dirname(actualImporter), specifier);
  if (!isWithin(root, unresolved)) {
    throw new PluginImportPolicyError(
      importer,
      specifier,
      "relative import escapes the plugin directory",
    );
  }

  if (!options.resolvedPath) return { kind: "local", path: unresolved };
  const resolvedPath = await realpath(options.resolvedPath);
  if (!isWithin(root, resolvedPath)) {
    throw new PluginImportPolicyError(
      importer,
      specifier,
      "resolved import escapes the plugin directory through a symlink",
    );
  }
  return { kind: "local", path: resolvedPath };
}
