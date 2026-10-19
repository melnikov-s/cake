import { describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { widgetPackageResolver } from "../../../../src/services/widgets/widget-package-resolver";
import { compileInlineWidget } from "../../../../src/services/widgets/inline-widget-service";

vi.mock("esbuild", () => ({
  build: vi.fn(() => {
    throw new Error("Unexpected bundling");
  }),
}));
vi.mock("../../../../src/services/widgets/widget-package-resolver", () => ({
  widgetPackageResolver: vi.fn(() => {
    throw new Error("Unexpected package resolution");
  }),
}));

describe("HTML widget compilation", () => {
  it("preserves inline interaction and injects scoped state without touching packages or bundling", async () => {
    const source =
      "<!doctype html><html><head><style>button{font:inherit}</style></head><body><button onclick=\"this.textContent='Clicked'\">Count</button><script>globalThis.interactive = true;</script></body></html>";
    const compiled = await compileInlineWidget("html", source, "artifact", {
      packageDirectory: "/missing-packages",
    });
    expect(compiled.document).toContain(source);
    expect(compiled.document).toContain(
      "globalThis.cakeArtifact = globalThis.__cakeArtifactBridge",
    );
    expect(compiled.document).toContain("event.source !== parent");
    expect(compiled.document).toContain("message.token !== token");
    expect(compiled.assets).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
    expect(widgetPackageResolver).not.toHaveBeenCalled();
  });

  it("does not grant artifact persistence to display, request or plugin HTML", async () => {
    for (const capability of ["display", "request", "session-plugin"] as const) {
      const compiled = await compileInlineWidget("html", "<button>Count</button>", capability);
      expect(compiled.document).not.toContain("globalThis.cakeArtifact =");
    }
  });
});
