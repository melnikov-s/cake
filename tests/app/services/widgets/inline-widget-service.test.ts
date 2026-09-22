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

  it("extracts a repaired fence without surrounding agent prose", () => {
    expect(
      extractRepairedWidget("Here is the fix:\n```cake-html\n<strong>Fixed</strong>\n```", "html"),
    ).toBe("<strong>Fixed</strong>");
  });

  it("injects the narrow request API into HTML widgets", async () => {
    const html = await compileInlineWidget(
      "html",
      "<button onclick=\"cakeRequest.submit({answer:'yes'})\">Yes</button>",
      "request",
    );
    expect(html.document).toContain("globalThis.cakeRequest");
    expect(html.document).toContain('send("submit", value)');
  });

  it("bundles the Cake Plugin SDK only for Session Plugins", async () => {
    const source = `
      import { useCake, usePluginState, useSharedState } from "@cake/plugin-sdk";
      export default function Tour() {
        const cake = useCake();
        const [state] = usePluginState({ current: 1 });
        const [shared] = useSharedState("tour", { total: 3 });
        return <button onClick={() => cake.session.sendMessage("Next")}>{state.current} / {shared.total}</button>;
      }
    `;
    const compiled = await compileInlineWidget("react", source, "session-plugin");
    expect(compiled.document).toContain("__cakePluginBridge");
    expect(compiled.document).toContain("plugin-call");
    expect(compiled.document).toContain("event.source !== parent");
    expect(compiled.document).toContain(
      "document.documentElement.dataset.theme = theme.colorScheme",
    );
    expect(compiled.document).toContain("background:var(--card)");
    expect(compiled.document).toContain(":focus-visible{outline:2px solid var(--ring)");
    await expect(compileInlineWidget("react", source, "display")).rejects.toThrow(
      "available only to Session Plugins",
    );
  });
});
