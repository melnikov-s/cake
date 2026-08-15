import { describe, expect, it } from "vitest";
import { compileInlineWidget, extractRepairedWidget } from "../../../src/main/inline-widget-service";

describe("inline widget service", () => {
  it("wraps free-form HTML in an isolated runtime document", async () => {
    const compiled = await compileInlineWidget("html", "<button onclick=\"document.body.dataset.clicked='yes'\">Try it</button>");

    expect(compiled.document).toContain("cake-inline-widget");
    expect(compiled.document).toContain("<button");
  });

  it("bundles a default-exported React widget and rejects non-React imports", async () => {
    const compiled = await compileInlineWidget("react", 'import { useState } from "react"; export default function Widget(){ const [n] = useState(1); return <strong>{n}</strong>; }');
    expect(compiled.document).toContain("cake-widget-root");
    expect(compiled.document.length).toBeGreaterThan(10_000);

    await expect(compileInlineWidget("react", 'import fs from "node:fs"; export default function Widget(){ return <div>{String(fs)}</div>; }'))
      .rejects.toThrow("may import React only");
  });

  it("extracts a repaired fence without surrounding agent prose", () => {
    expect(extractRepairedWidget("Here is the fix:\n```cake-html\n<strong>Fixed</strong>\n```", "html")).toBe("<strong>Fixed</strong>");
  });

  it("injects the narrow request API and passes it as React component props", async () => {
    const html = await compileInlineWidget("html", "<button onclick=\"cakeRequest.submit({answer:'yes'})\">Yes</button>", "request");
    expect(html.document).toContain("globalThis.cakeRequest");
    expect(html.document).toContain('send("submit", value)');

    const react = await compileInlineWidget("react", "export default function Request({ submit }) { return <button onClick={() => submit({ answer: 'yes' })}>Yes</button>; }", "request");
    expect(react.document).toContain("globalThis.cakeRequest");
  });
});
