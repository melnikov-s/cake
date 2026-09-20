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
  });

  it("bundles approved D3 modules for local visualizations", async () => {
    const compiled = await compileInlineWidget(
      "react",
      'import { scaleLinear } from "d3-scale"; import { line } from "d3-shape"; export default function Widget(){ const scale = scaleLinear().domain([0, 1]).range([0, 10]); return <svg aria-label="D3 chart"><path d={line([[0, scale(0)], [1, scale(1)]]) ?? ""} /><text>{scale(0.5)}</text></svg>; }',
    );

    expect(compiled.document).toContain("cake-widget-root");
    expect(compiled.document).toContain("D3");
  });

  it("rejects every direct import outside the exact allowlist", async () => {
    for (const specifier of ["node:fs", "lodash"]) {
      await expect(
        compileInlineWidget(
          "react",
          `import value from ${JSON.stringify(specifier)}; export default function Widget(){ return <div>{String(value)}</div>; }`,
        ),
      ).rejects.toThrow("approved D3 modules");
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
