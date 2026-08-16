import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import ts from "typescript";
import { z } from "zod";
import { build, type Plugin as VitePlugin } from "vite";
import type { PluginDiagnostic } from "../plugin/plugin-contract";
import type { CakePaths } from "./cake-paths";
import { validatePluginImport } from "./plugin-import-policy";
import { PluginRepository, type CustomizationSource } from "./plugin-repository";

export interface CandidateBuild {
  revision: string;
  sourceRevision: string;
  directory: string;
  indexHtml: string;
  diagnostics: PluginDiagnostic[];
}

const authoringSnapshotSchema = z.object({ schemaVersion: z.number(), cakeVersion: z.string() });
const runtimePackageSchema = z.object({ version: z.string() });
const rendererBuildMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  coreRevision: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  buildRevision: z.string().regex(/^[a-f0-9]{64}$/)
});

interface PluginCompilerPaths {
  [specifier: string]: string[];
}

async function typescriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", "out", "dist"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
    }
  };
  await visit(root);
  return files;
}

function policyPlugin(source: CustomizationSource, sourceRoot: string, runtimeRoot = sourceRoot): VitePlugin {
  const pluginById = new Map(source.plugins.map((plugin) => [`plugin:${plugin.manifest.id}`, plugin]));
  const belongsTo = (root: string, importer: string) => {
    const child = relative(root, importer);
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  };
  const owner = (importer: string) => {
    const plugin = source.plugins.find((candidate) => belongsTo(candidate.root, importer));
    if (plugin) return { kind: "plugin" as const, root: plugin.root };
    const sceneRoot = dirname(source.scene);
    if (belongsTo(sceneRoot, importer)) {
      return { kind: "scene" as const, root: sceneRoot };
    }
    return undefined;
  };
  const sharedRuntimePaths = new Set(["react/index.js", "react/jsx-runtime.js", "react/jsx-dev-runtime.js", "react-dom/index.js", "zod/index.js"].map((path) => resolve(runtimeRoot, "node_modules", path)));
  sharedRuntimePaths.add(resolve(sourceRoot, "src/renderer/cake.ts"));
  return {
    name: "cake-plugin-import-policy",
    enforce: "pre",
    async resolveId(specifier, importer) {
      if (pluginById.has(specifier)) {
        if (!importer || owner(importer)?.kind !== "scene") throw new Error(`${importer ?? "unknown"}: plugin definitions may only be imported by the global scene`);
        return pluginById.get(specifier)!.entry;
      }
      if (!importer) return null;
      const sourceOwner = owner(importer);
      if (!sourceOwner) return null;
      if (sharedRuntimePaths.has(specifier)) return null;
      const initial = await validatePluginImport({ pluginRoot: sourceOwner.root, importer, specifier });
      if (initial.kind === "shared") return null;
      const resolved = await this.resolve(specifier, importer, { skipSelf: true });
      if (!resolved || resolved.external) throw new Error(`${importer}: could not resolve plugin import ${JSON.stringify(specifier)}`);
      await validatePluginImport({ pluginRoot: sourceOwner.root, importer, specifier, resolvedPath: resolved.id.split("?", 1)[0] });
      return resolved;
    }
  };
}

function formatDiagnostic(diagnostic: ts.Diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}: ${message}`;
}

export class PluginBuildService {
  readonly repository: PluginRepository;
  private coreRevisionPromise: Promise<string> | undefined;
  constructor(readonly paths: CakePaths, readonly sourceRoot: string, readonly runtimeRoot = sourceRoot) {
    this.repository = new PluginRepository(paths);
  }

  private coreRevision() {
    if (this.coreRevisionPromise) return this.coreRevisionPromise;
    this.coreRevisionPromise = (async () => {
      const hash = createHash("sha256");
      const roots = ["package.json", "src/renderer", "src/ipc", "src/plugin"];
      const visit = async (path: string, label: string) => {
        const entries = await readdir(path, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
          const child = join(path, entry.name);
          const childLabel = `${label}/${entry.name}`;
          if (entry.isDirectory()) await visit(child, childLabel);
          else if (entry.isFile()) hash.update(childLabel).update("\0").update(await readFile(child)).update("\0");
        }
      };
      for (const relativePath of roots) {
        const path = resolve(this.sourceRoot, relativePath);
        if (relativePath === "package.json") hash.update(relativePath).update("\0").update(await readFile(path)).update("\0");
        else await visit(path, relativePath);
      }
      return hash.digest("hex");
    })();
    return this.coreRevisionPromise;
  }

  async isBuildCurrent(revision: string) {
    try {
      const metadata = rendererBuildMetadataSchema.parse(JSON.parse(await readFile(join(this.paths.recovery, "builds", revision, "cake-build.json"), "utf8")));
      return metadata.buildRevision === revision && metadata.coreRevision === await this.coreRevision();
    } catch {
      return false;
    }
  }

  private async typecheck(source: CustomizationSource): Promise<PluginDiagnostic[]> {
    const rootNames = [source.scene, resolve(this.sourceRoot, "src/renderer/env.d.ts")];
    for (const plugin of source.plugins) rootNames.push(...await typescriptFiles(plugin.root));
    const paths: PluginCompilerPaths = {
      cake: [resolve(this.sourceRoot, "src/renderer/cake.ts")],
      "@/*": [resolve(this.sourceRoot, "src/renderer/*")],
      react: [resolve(this.runtimeRoot, "node_modules/@types/react/index.d.ts")],
      "react/jsx-runtime": [resolve(this.runtimeRoot, "node_modules/@types/react/jsx-runtime.d.ts")],
      "react/jsx-dev-runtime": [resolve(this.runtimeRoot, "node_modules/@types/react/jsx-dev-runtime.d.ts")],
      "react-dom": [resolve(this.runtimeRoot, "node_modules/@types/react-dom/index.d.ts")],
      zod: [resolve(this.runtimeRoot, "node_modules/zod/index.d.ts")]
    };
    for (const plugin of source.plugins) paths[`plugin:${plugin.manifest.id}`] = [plugin.entry];
    const program = ts.createProgram({
      rootNames,
      options: {
        allowJs: false, baseUrl: this.sourceRoot, esModuleInterop: true, isolatedModules: true,
        jsx: ts.JsxEmit.ReactJSX, lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true, noUncheckedIndexedAccess: true, paths, resolveJsonModule: true,
        skipLibCheck: true, strict: true, target: ts.ScriptTarget.ES2022, types: ["node", "vite/client"]
      }
    });
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({ phase: "typecheck" as const, file: diagnostic.file?.fileName, message: formatDiagnostic(diagnostic) }));
  }

  async buildCandidate(): Promise<CandidateBuild> {
    const source = await this.repository.inspect();
    const coreRevision = await this.coreRevision();
    const revision = createHash("sha256").update(source.revision).update("\0").update(coreRevision).digest("hex");
    if (this.sourceRoot !== this.runtimeRoot) {
      try {
        const [snapshot, runtimePackage] = await Promise.all([
          readFile(join(this.sourceRoot, "cake-authoring.json"), "utf8").then((source) => authoringSnapshotSchema.parse(JSON.parse(source))),
          readFile(join(this.runtimeRoot, "package.json"), "utf8").then((source) => runtimePackageSchema.parse(JSON.parse(source)))
        ]);
        if (snapshot.schemaVersion !== 1 || snapshot.cakeVersion !== runtimePackage.version) throw new Error(`Authoring snapshot ${snapshot.cakeVersion} does not match Cake ${runtimePackage.version}`);
      } catch (error) {
        return { revision, sourceRevision: source.revision, directory: "", indexHtml: "", diagnostics: [{ phase: "bundle", message: `Cake's packaged authoring snapshot is unavailable or mismatched: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
    try { await this.repository.snapshotSource(source); }
    catch (error) {
      return { revision, sourceRevision: source.revision, directory: "", indexHtml: "", diagnostics: [{ phase: "bundle", message: error instanceof Error ? error.message : String(error) }] };
    }
    const diagnostics = [...source.diagnostics, ...await this.typecheck(source)];
    if (diagnostics.length) return { revision, sourceRevision: source.revision, directory: "", indexHtml: "", diagnostics };
    const directory = join(this.paths.recovery, "builds", revision);
    await mkdir(directory, { recursive: true });
    try {
      await build({
        configFile: false,
        root: resolve(this.sourceRoot, "src/renderer"),
        base: "./",
        define: { __CAKE_CUSTOMIZATION_REVISION__: JSON.stringify(revision) },
        resolve: { alias: [
          { find: "virtual:cake-global-scene", replacement: source.scene },
          { find: "cake", replacement: resolve(this.sourceRoot, "src/renderer/cake.ts") },
          { find: "@", replacement: resolve(this.sourceRoot, "src/renderer") },
          { find: "react/jsx-runtime", replacement: resolve(this.runtimeRoot, "node_modules/react/jsx-runtime.js") },
          { find: "react/jsx-dev-runtime", replacement: resolve(this.runtimeRoot, "node_modules/react/jsx-dev-runtime.js") },
          { find: /^react$/, replacement: resolve(this.runtimeRoot, "node_modules/react/index.js") },
          { find: /^react-dom$/, replacement: resolve(this.runtimeRoot, "node_modules/react-dom/index.js") },
          { find: /^zod$/, replacement: resolve(this.runtimeRoot, "node_modules/zod/index.js") }
        ] },
        plugins: [policyPlugin(source, this.sourceRoot, this.runtimeRoot), react(), tailwindcss()],
        build: { outDir: directory, emptyOutDir: true, rollupOptions: { input: resolve(this.sourceRoot, "src/renderer/index.html") } }
      });
      const current = await this.repository.inspect();
      if (current.revision !== source.revision) {
        await rm(directory, { recursive: true, force: true });
        return { revision, sourceRevision: current.revision, directory: "", indexHtml: "", diagnostics: [{ phase: "bundle", message: `Customization source changed during build: started at ${source.revision}, finished at ${current.revision}` }] };
      }
      await writeFile(join(directory, "cake-build.json"), `${JSON.stringify(rendererBuildMetadataSchema.parse({ schemaVersion: 1, coreRevision, sourceRevision: source.revision, buildRevision: revision }), null, 2)}\n`);
      return { revision, sourceRevision: source.revision, directory, indexHtml: join(directory, "index.html"), diagnostics: [] };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      return { revision, sourceRevision: source.revision, directory: "", indexHtml: "", diagnostics: [{ phase: "bundle", message: error instanceof Error ? error.stack ?? error.message : String(error) }] };
    }
  }
}
