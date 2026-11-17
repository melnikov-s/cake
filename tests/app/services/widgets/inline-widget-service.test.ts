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

  it("compiles artifact SDK imports and rejects them for display widgets", async () => {
    const source =
      'import { useArtifactState, useArtifact } from "@cake/artifact-sdk"; export default function Widget(){ const state = useArtifactState({items: []}); const artifact = useArtifact(); return <p>{state.hydrated ? JSON.stringify(state.value) : "Loading"}</p>; }';
    const compiled = await compileInlineWidget("react", source, "artifact");
    expect(compiled.document).toContain("cake-widget-root");
    await expect(compileInlineWidget("react", source, "display")).rejects.toThrow(
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
  });

  it("compiles current-session, event and polling hook imports from the artifact SDK", async () => {
    const source =
      'import { useCake, useCurrentSession, useCakeEvent, usePolling } from "@cake/artifact-sdk"; export default function Widget(){ const cake = useCake(); const session = useCurrentSession(); useCakeEvent("session.changed", {}, () => {}); usePolling(null, () => {}); return <p>{session?.sessionId ?? "No session"}</p>; }';
    const compiled = await compileInlineWidget("react", source, "artifact");
    expect(compiled.document).toContain("cake-widget-root");
  });
});
