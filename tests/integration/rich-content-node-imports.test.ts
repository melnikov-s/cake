import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Bundle application TS only, then execute in a real Node process without
// Vitest mocks. The loader rejects Electron even if an import could otherwise
// succeed in Node (the installed electron package exports a binary path).
async function importInNode(source: string) {
  const directory = await mkdtemp(join(process.cwd(), ".rich-content-node-test-"));
  try {
    const outfile = join(directory, "entry.mjs");
    await build({
      stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
      outfile,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "node22",
    });
    const hook = `export async function resolve(specifier, context, nextResolve) {
      if (specifier === "electron" || specifier.startsWith("electron/")) {
        throw new Error("Forbidden Electron runtime dependency: " + specifier);
      }
      return nextResolve(specifier, context);
    }`;
    const bootstrap = `
      import { register } from "node:module";
      register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url);
      await import(${JSON.stringify(pathToFileURL(outfile).href)});
      console.log("node-import-ok");
    `;
    const result = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      bootstrap,
    ]);
    expect(result.stdout.trim()).toBe("node-import-ok");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("widget_registry_imports_without_electron", () =>
  importInNode(`
  import assert from "node:assert/strict";
  import { publishInlineWidget, inlineWidgetDocument, revokeInlineWidget } from "./src/services/widgets/inline-widget-document-registry.ts";
  const published = publishInlineWidget({ token: "00000000-0000-4000-8000-000000000001", document: "<html>widget</html>" });
  assert.equal(published.url, "cake-widget://document/" + published.token);
  assert.equal(inlineWidgetDocument(published.token), "<html>widget</html>");
  revokeInlineWidget(published.token);
  assert.equal(inlineWidgetDocument(published.token), undefined);
`));

it("extension_publication_imports_without_electron", () =>
  importInNode(`
  import assert from "node:assert/strict";
  import { publishExtensionCompanionModule, extensionCompanionModuleSource } from "./src/services/pi/runtime/extension-companion-module-registry.ts";
  import { loadExtensionCompanions } from "./src/services/pi/runtime/extension-companions.ts";
  const published = publishExtensionCompanionModule("export default 1");
  assert.equal(published.url, "cake-extension://module/" + published.token);
  assert.equal(extensionCompanionModuleSource(published.token), "export default 1");
  published.release();
  assert.equal(extensionCompanionModuleSource(published.token), undefined);
  const loaded = await loadExtensionCompanions({ getExtensions: () => ({ extensions: [] }) });
  assert.deepEqual(loaded.companions, []);
  loaded.dispose();
`));

it("capture_contract_imports_without_electron", () =>
  importInNode(`
  import assert from "node:assert/strict";
  import { RenderedWidgetCapture, RenderedWidgetCaptureError } from "./src/services/widgets/RenderedWidgetCapture.ts";
  assert.equal(RenderedWidgetCapture.key, "cake/services/widgets/RenderedWidgetCapture");
  assert.equal(new RenderedWidgetCaptureError({ kind: "infrastructure", message: "unavailable" }).kind, "infrastructure");
`));
