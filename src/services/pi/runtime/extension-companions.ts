import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { build, type Plugin } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Option, Schema } from "effect";
import {
  extensionCompanionSchema,
  resourceDiagnosticSchema,
  type ExtensionCompanion,
  type ResourceDiagnostic,
} from "../../../ipc/session-contract";
import {
  publishExtensionCompanionModule,
  type ExtensionCompanionModulePublication,
} from "./extension-companion-protocol";

export const cakeCompanionStateChannel = "cake:companion:state";
export const cakeCompanionActionChannel = "cake:companion:action";

export const cakeCompanionStatePayloadSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  state: Schema.Json,
});

const companionManifestEntrySchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  extension: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  entry: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  slot: Schema.Literal("composer.above"),
  actions: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
      Schema.isMaxLength(100),
    ),
  ),
});
const packageCakeFieldSchema = Schema.Struct({ cake: Schema.optionalKey(Schema.Unknown) });
const packageManifestSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  cake: Schema.optionalKey(
    Schema.Struct({
      companions: Schema.Array(companionManifestEntrySchema).check(Schema.isMaxLength(100)),
    }),
  ),
});

const reactExports = [
  "Children",
  "Component",
  "Fragment",
  "Profiler",
  "PureComponent",
  "StrictMode",
  "Suspense",
  "cloneElement",
  "createContext",
  "createElement",
  "createRef",
  "forwardRef",
  "isValidElement",
  "lazy",
  "memo",
  "startTransition",
  "use",
  "useActionState",
  "useCallback",
  "useContext",
  "useDebugValue",
  "useDeferredValue",
  "useEffect",
  "useId",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
  "useOptimistic",
  "useReducer",
  "useRef",
  "useState",
  "useSyncExternalStore",
  "useTransition",
] as const;

const reactHostPlugin: Plugin = {
  name: "cake-extension-react-host",
  setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "cake-host" }));
    builder.onLoad({ filter: /^react$/, namespace: "cake-host" }, () => ({
      loader: "js",
      contents: `const React = globalThis.__cakeExtensionReact;\nexport default React;\n${reactExports.map((name) => `export const ${name} = React.${name};`).join("\n")}`,
    }));
  },
};

export interface LoadedExtensionCompanions {
  readonly companions: ExtensionCompanion[];
  readonly diagnostics: ResourceDiagnostic[];
  readonly dispose: () => void;
}

function resourceDiagnostic(input: ResourceDiagnostic): ResourceDiagnostic {
  const bounded: ResourceDiagnostic = {
    id: input.id.slice(0, 8_192) || "companion:diagnostic",
    severity: input.severity,
    source: input.source,
    message: input.message.slice(0, 4_096),
  };
  if (input.path !== undefined) Object.assign(bounded, { path: input.path.slice(0, 8_192) });
  if (input.method !== undefined) Object.assign(bounded, { method: input.method.slice(0, 256) });
  return Schema.decodeUnknownSync(resourceDiagnosticSchema)(bounded);
}

export async function loadExtensionCompanions(
  resourceLoader: ResourceLoader,
): Promise<LoadedExtensionCompanions> {
  const companions: ExtensionCompanion[] = [];
  const diagnostics: ResourceDiagnostic[] = [];
  const seenIds = new Set<string>();
  const publications: ExtensionCompanionModulePublication[] = [];
  const loadedExtensions = resourceLoader.getExtensions().extensions;
  const packageRoots = new Set(
    loadedExtensions.flatMap((extension) =>
      extension.sourceInfo.baseDir ? [extension.sourceInfo.baseDir] : [],
    ),
  );

  for (const baseDir of packageRoots) {
    const packagePath = resolve(baseDir, "package.json");
    let document: unknown;
    try {
      document = JSON.parse(await readFile(packagePath, "utf8"));
    } catch {
      continue;
    }
    const cakeField = Schema.decodeUnknownOption(packageCakeFieldSchema)(document);
    if (Option.isNone(cakeField) || cakeField.value.cake === undefined) continue;
    const decoded = Schema.decodeUnknownOption(packageManifestSchema)(document);
    if (Option.isNone(decoded) || !decoded.value.cake) {
      diagnostics.push(
        resourceDiagnostic({
          id: `companion:${baseDir}:manifest`,
          severity: "error",
          source: "compatibility",
          method: "cake.companions",
          path: packagePath,
          message: "The package has an invalid Cake companion manifest",
        }),
      );
      continue;
    }
    const parsed = decoded.value;

    for (const manifest of parsed.cake?.companions ?? []) {
      if (
        !loadedExtensions.some(
          (extension) =>
            extension.sourceInfo.baseDir === baseDir &&
            resolve(baseDir, manifest.extension) === resolve(extension.resolvedPath),
        )
      )
        continue;
      if (seenIds.has(manifest.id)) {
        diagnostics.push(
          resourceDiagnostic({
            id: `companion:${manifest.id}:duplicate`,
            severity: "error",
            source: "compatibility",
            method: "cake.companions",
            path: packagePath,
            message: `Cake companion id ${manifest.id} is registered more than once`,
          }),
        );
        continue;
      }
      let publication: ExtensionCompanionModulePublication | undefined;
      try {
        const componentEntry = resolve(baseDir, manifest.entry);
        const result = await build({
          stdin: {
            contents: `import Component from ${JSON.stringify(componentEntry)}; export default Component;`,
            resolveDir: baseDir,
            sourcefile: "cake-extension-companion-entry.ts",
            loader: "ts",
          },
          absWorkingDir: baseDir,
          bundle: true,
          format: "esm",
          platform: "browser",
          target: "es2022",
          write: false,
          sourcemap: "inline",
          jsx: "transform",
          jsxFactory: "React.createElement",
          jsxFragment: "React.Fragment",
          banner: { js: "const React = globalThis.__cakeExtensionReact;" },
          plugins: [reactHostPlugin],
        });
        const source = result.outputFiles[0]?.text;
        if (!source) throw new Error("esbuild produced no JavaScript output");
        if (source.length > 1_000_000) throw new Error("compiled module exceeds the 1 MB limit");
        publication = publishExtensionCompanionModule(source);
        const companion = Schema.decodeUnknownSync(extensionCompanionSchema)({
          id: manifest.id,
          name: parsed.name ?? manifest.id,
          slot: manifest.slot,
          moduleUrl: publication.url,
          actions: [...(manifest.actions ?? [])],
          state: null,
        });
        companions.push(companion);
        publications.push(publication);
        publication = undefined;
        seenIds.add(manifest.id);
      } catch (error) {
        publication?.release();
        diagnostics.push(
          resourceDiagnostic({
            id: `companion:${manifest.id}:build`,
            severity: "error",
            source: "compatibility",
            method: "cake.companions",
            path: resolve(baseDir, manifest.entry),
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  let disposed = false;
  return {
    companions,
    diagnostics,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const publication of publications) publication.release();
    },
  };
}
