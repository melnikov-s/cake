import { describe, expect, it } from "vitest";
import scrollbarStyles from "../../../../src/utils/scrollbars.css?raw";
import { inlineWidgetLayoutRequirements } from "../../../../src/services/pi/runtime/sidecar-runtime";
import { compileInlineWidget } from "../../../../src/services/widgets/inline-widget-service";

describe("inline widget service", () => {
  it("wraps free-form HTML in an isolated runtime document", async () => {
    const compiled = await compileInlineWidget(
      "html",
      "<button onclick=\"document.body.dataset.clicked='yes'\">Try it</button>",
    );

    expect(compiled.document).toContain("cake-inline-widget");
    expect(compiled.document).toContain(`<style>${scrollbarStyles}</style>`);
    expect(compiled.document).toContain("<button");
    expect(compiled.document).toContain("body>*{max-width:100%}");
    expect(compiled.document).toContain("overflow-wrap:anywhere");
    expect(compiled.document).toContain('<html data-sizing="viewport">');
    expect(compiled.document).toContain(
      'html[data-sizing="viewport"] #cake-widget-root{height:100%;min-height:0}',
    );
  });

  it("gives generation and repair agents one collision-free responsive layout contract", () => {
    expect(inlineWidgetLayoutRequirements).toContain("Responsive 320px–desktop");
    expect(inlineWidgetLayoutRequirements).toContain("no overlap/horizontal page scroll");
    expect(inlineWidgetLayoutRequirements).toContain("Use flex/grid, wrapping and min-width:0");
    expect(inlineWidgetLayoutRequirements).toContain("absolute geometry only inside canvases");
    expect(inlineWidgetLayoutRequirements).toContain("height:100%, min-height:0 and flex:1 canvas");
    expect(inlineWidgetLayoutRequirements).toContain("resize without remount/state loss");
  });

  it("bundles the artifact state, runtime tool and canonical Cake SDK only in artifact widgets", async () => {
    const source =
      'import { useArtifactState, useArtifact } from "@cake/artifact-sdk"; export default function Widget(){ const state = useArtifactState({items: []}); const artifact = useArtifact(); return <p>{state.hydrated ? JSON.stringify(state.value) : "Loading"}</p>; }';
    const compiled = await compileInlineWidget("react", source, "artifact");
    expect(compiled.document).toContain("__cakeArtifactBridge");
    expect(compiled.document).toContain("artifact-state-replace");
    expect(compiled.document).toContain("globalThis.cake = Object.freeze");
    expect(compiled.document).toContain('requestCall("artifact-tool-call"');
    expect(compiled.document).toContain('requestCall("artifact-cake-call"');
    expect(compiled.document).toContain('message.type !== "call-result"');
    expect(compiled.document).toContain("Artifact state is not hydrated");
    await expect(compileInlineWidget("react", source, "display")).rejects.toThrow(
      "available only to artifact widgets",
    );
    await expect(compileInlineWidget("react", source, "session-plugin")).rejects.toThrow(
      "available only to artifact widgets",
    );
  });

  it("injects the narrow request API into HTML widgets", async () => {
    const html = await compileInlineWidget(
      "html",
      "<button onclick=\"cakeRequest.submit({answer:'yes'})\">Yes</button>",
      "request",
    );
    expect(html.document).toContain('<html data-sizing="content">');
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
    expect(compiled.document).toContain('<html data-sizing="content">');
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
