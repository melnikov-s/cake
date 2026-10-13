import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BootstrapLive } from "../../src/main/BootstrapLive";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import { makeWidgetPackagesLive } from "../../src/services/widgets/WidgetPackagesLive";
import { WidgetPackages } from "../../src/services/widgets/WidgetPackages";
import { WidgetBrowserOutputs } from "../../src/services/widgets/WidgetBrowserOutputs";
import { makeWidgetBrowserOutputsLive } from "../../src/services/widgets/WidgetBrowserOutputsLive";
import {
  inlineWidgetResource,
  publishInlineWidget,
  revokeInlineWidget,
} from "../../src/services/widgets/inline-widget-document-registry";

describe("inline widget compiler with user-installed packages", () => {
  let directory: string;
  let packages: ManagedRuntime.ManagedRuntime<WidgetPackages, never>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cake-widget-packages-"));
    packages = ManagedRuntime.make(
      makeWidgetPackagesLive({ directory: join(directory, "packages") }).pipe(
        Layer.provide(BootstrapLive),
      ),
    );
    await packages.runPromise(
      Effect.flatMap(WidgetPackages, (service) => service.install("d3-scale@4.0.2")),
    );
    await packages.runPromise(
      Effect.flatMap(WidgetPackages, (service) => service.install("@excalidraw/excalidraw@0.18.1")),
    );
  }, 120_000);
  afterAll(async () => {
    await packages?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("bundles a default-exported React widget without packages", async () => {
    const compiled = await compileInlineWidget(
      "react",
      'import { useState } from "react"; export default function Widget(){ const [n] = useState(1); return <strong>{n}</strong>; }',
    );
    expect(compiled.document).toContain("cake-widget-root");
    expect(compiled.document.length).toBeGreaterThan(10_000);
  });

  it("resolves an actual external package and its transitives from the shared environment", async () => {
    const compiled = await compileInlineWidget(
      "react",
      'import { scaleLinear } from "d3-scale"; export default function Widget(){ return <div>{scaleLinear().domain([0, 1]).range([0, 10])(0.5)}</div>; }',
      "display",
      { packageDirectory: join(directory, "packages") },
    );
    expect(compiled.document).toContain("cake-widget-root");
    expect(compiled.document.length).toBeGreaterThan(10_000);
    expect(compiled.document).not.toContain(directory);
  });

  it("bundles Excalidraw CSS and generic runtime font assets with a single React runtime", async () => {
    const compiled = await compileInlineWidget(
      "react",
      'import { Excalidraw } from "@excalidraw/excalidraw"; import "@excalidraw/excalidraw/index.css"; import assetBase from "@cake/assets/@excalidraw/excalidraw/dist/prod/"; window.EXCALIDRAW_ASSET_PATH = assetBase; export default function Widget(){ return <Excalidraw />; }',
      "display",
      { packageDirectory: join(directory, "packages") },
    );
    expect(compiled.document).toContain(".excalidraw");
    expect(
      compiled.assets?.some(
        (asset) => asset.path.endsWith(".woff2") && asset.contentType === "font/woff2",
      ),
    ).toBe(true);
    expect(compiled.document.match(/react\/cjs\/react\.production\.js:/g)).toHaveLength(1);
    const outputs = ManagedRuntime.make(makeWidgetBrowserOutputsLive(join(directory, "outputs")));
    try {
      const browser = await outputs.runPromise(
        Effect.flatMap(WidgetBrowserOutputs, (service) => service.retain(compiled)),
      );
      expect(JSON.stringify(browser).length).toBeLessThan(100);
      // A new Service instance models process restart. Package removal cannot affect the build.
      await packages.runPromise(
        Effect.flatMap(WidgetPackages, (service) => service.remove("@excalidraw/excalidraw")),
      );
      await expect(
        compileInlineWidget(
          "react",
          'import { Excalidraw } from "@excalidraw/excalidraw"; export default function Widget(){ return <Excalidraw />; }',
          "display",
          { packageDirectory: join(directory, "packages") },
        ),
      ).rejects.toThrow("not installed");
      const reopenedOutputs = ManagedRuntime.make(
        makeWidgetBrowserOutputsLive(join(directory, "outputs")),
      );
      try {
        const reopened = await reopenedOutputs.runPromise(
          Effect.flatMap(WidgetBrowserOutputs, (service) => service.open(browser)),
        );
        expect(reopened.token).not.toBe(compiled.token);
        expect(reopened.document).not.toContain(compiled.token);
        expect(reopened.assets).toEqual(compiled.assets);
        const widget = publishInlineWidget(reopened);
        try {
          expect(inlineWidgetResource(widget.token, reopened.assets![0]!.path)?.data).toEqual(
            reopened.assets![0]!.data,
          );
        } finally {
          revokeInlineWidget(widget.token);
        }
      } finally {
        await reopenedOutputs.dispose();
      }
    } finally {
      await outputs.dispose();
    }
  }, 120_000);

  it("rejects host files, undeclared packages and Node builtins", async () => {
    for (const specifier of ["node:fs", "lodash", "./local", "/tmp/source.ts"])
      await expect(
        compileInlineWidget(
          "react",
          `import value from ${JSON.stringify(specifier)}; export default function Widget(){ return <div>{String(value)}</div>; }`,
          "display",
          { packageDirectory: join(directory, "packages") },
        ),
      ).rejects.toThrow();
  });

  it("injects the request API as React component props", async () => {
    const compiled = await compileInlineWidget(
      "react",
      "export default function Request({ submit }) { return <button onClick={() => submit({ answer: 'yes' })}>Yes</button>; }",
      "request",
    );
    expect(compiled.document).toContain("globalThis.cakeRequest");
  });
});
