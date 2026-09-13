import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";

describe("inline widget compiler", () => {
  it("bundles a default-exported React widget", async () => {
    const compiled = await compileInlineWidget(
      "react",
      'import { useState } from "react"; export default function Widget(){ const [n] = useState(1); return <strong>{n}</strong>; }',
    );

    expect(compiled.document).toContain("cake-widget-root");
    expect(compiled.document.length).toBeGreaterThan(10_000);
    expect(compiled.document).not.toContain('data-cake-widget-library="@xyflow/react"');
  });

  it("bundles approved D3 modules for local visualizations", async () => {
    const compiled = await compileInlineWidget(
      "react",
      'import { scaleLinear } from "d3-scale"; import { line } from "d3-shape"; export default function Widget(){ const scale = scaleLinear().domain([0, 1]).range([0, 10]); return <svg aria-label="D3 chart"><path d={line([[0, scale(0)], [1, scale(1)]]) ?? ""} /><text>{scale(0.5)}</text></svg>; }',
    );

    expect(compiled.document).toContain("cake-widget-root");
    expect(compiled.document).toContain("D3");
  });

  it("bundles React Flow with its required sandbox-local stylesheet", async () => {
    const compiled = await compileInlineWidget(
      "react",
      `import { Background, ReactFlow } from "@xyflow/react";
       export default function Widget() {
         return <div style={{ height: 320 }}><ReactFlow nodes={[]} edges={[]}><Background /></ReactFlow></div>;
       }`,
    );

    expect(compiled.document).toContain('data-cake-widget-library="@xyflow/react"');
    expect(compiled.document).toContain(".react-flow__renderer");
    expect(compiled.document).not.toContain("@xyflow/react/dist/style.css");
  });

  it("resolves the browser-safe ELK and React Flow packages from Cake rather than cwd", async () => {
    const originalCwd = process.cwd();
    const isolatedCwd = mkdtempSync(join(tmpdir(), "cake-widget-compiler-"));
    try {
      process.chdir(isolatedCwd);
      const compiled = await compileInlineWidget(
        "react",
        `import { ReactFlow } from "@xyflow/react";
         import ELK from "elkjs/lib/elk.bundled.js";
         const elk = new ELK();
         export default function Widget() {
           void elk.layout({ id: "root", children: [] });
           return <div style={{ height: 320 }}><ReactFlow nodes={[]} edges={[]} /></div>;
         }`,
      );

      expect(compiled.document).toContain("cake-widget-root");
      expect(compiled.document).toContain('data-cake-widget-library="@xyflow/react"');
      expect(compiled.document).not.toMatch(/<script[^>]+src=/);
    } finally {
      process.chdir(originalCwd);
      rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it("rejects every direct import outside the exact allowlist", async () => {
    for (const specifier of [
      "node:fs",
      "lodash",
      "elkjs",
      "@xyflow/react/dist/style.css",
      "@xyflow/system",
    ]) {
      await expect(
        compileInlineWidget(
          "react",
          `import value from ${JSON.stringify(specifier)}; export default function Widget(){ return <div>{String(value)}</div>; }`,
        ),
      ).rejects.toThrow("@xyflow/react, or elkjs/lib/elk.bundled.js only");
    }
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
