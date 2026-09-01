import { describe, expect, it } from "vitest";
import { inlineWidgetLayoutRequirements } from "../../../../src/services/pi/runtime/sidecar-runtime";
import {
  compileInlineWidget,
  extractRepairedWidget,
} from "../../../../src/services/widgets/inline-widget-service";

describe("inline widget service", () => {
  it("wraps free-form HTML in an isolated runtime document", async () => {
    const compiled = await compileInlineWidget(
      "html",
      "<button onclick=\"document.body.dataset.clicked='yes'\">Try it</button>",
    );

    expect(compiled.document).toContain("cake-inline-widget");
    expect(compiled.document).toContain("<button");
    expect(compiled.document).toContain("body>*{max-width:100%}");
    expect(compiled.document).toContain("overflow-wrap:anywhere");
  });

  it("gives generation and repair agents one collision-free responsive layout contract", () => {
    expect(inlineWidgetLayoutRequirements).toContain(
      "from 320 CSS pixels through wide desktop sizes",
    );
    expect(inlineWidgetLayoutRequirements).toContain(
      "do not use absolute or fixed positioning for structural text",
    );
    expect(inlineWidgetLayoutRequirements).toContain("No text or interactive control may overlap");
  });

  it("bundles a default-exported React widget and rejects non-approved imports", async () => {
    const compiled = await compileInlineWidget(
      "react",
      'import { useState } from "react"; export default function Widget(){ const [n] = useState(1); return <strong>{n}</strong>; }',
    );
    expect(compiled.document).toContain("cake-widget-root");
    expect(compiled.document.length).toBeGreaterThan(10_000);

    await expect(
      compileInlineWidget(
        "react",
        'import fs from "node:fs"; export default function Widget(){ return <div>{String(fs)}</div>; }',
      ),
    ).rejects.toThrow("approved D3 modules only");
    await expect(
      compileInlineWidget(
        "react",
        'import value from "lodash"; export default function Widget(){ return <div>{String(value)}</div>; }',
      ),
    ).rejects.toThrow("approved D3 modules only");
  });

  it("bundles approved D3 modules for local visualizations", async () => {
    const compiled = await compileInlineWidget(
      "react",
      'import { scaleLinear } from "d3-scale"; import { line } from "d3-shape"; export default function Widget(){ const scale = scaleLinear().domain([0, 1]).range([0, 10]); return <svg aria-label="D3 chart"><path d={line([[0, scale(0)], [1, scale(1)]]) ?? ""} /><text>{scale(0.5)}</text></svg>; }',
    );
    expect(compiled.document).toContain("cake-widget-root");
    expect(compiled.document).toContain("D3");
  });

  it("extracts a repaired fence without surrounding agent prose", () => {
    expect(
      extractRepairedWidget("Here is the fix:\n```cake-html\n<strong>Fixed</strong>\n```", "html"),
    ).toBe("<strong>Fixed</strong>");
  });

  it("injects the narrow request API and passes it as React component props", async () => {
    const html = await compileInlineWidget(
      "html",
      "<button onclick=\"cakeRequest.submit({answer:'yes'})\">Yes</button>",
      "request",
    );
    expect(html.document).toContain("globalThis.cakeRequest");
    expect(html.document).toContain('send("submit", value)');

    const react = await compileInlineWidget(
      "react",
      "export default function Request({ submit }) { return <button onClick={() => submit({ answer: 'yes' })}>Yes</button>; }",
      "request",
    );
    expect(react.document).toContain("globalThis.cakeRequest");
  });
});
