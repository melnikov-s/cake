import { describe, expect, it } from "vitest";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import { encodePrototype, prototypeFixture } from "../fixtures/prototype-source";

describe("prototype module compilation", () => {
  it("bundles the one five-option chooser and real transitive shared imports", async () => {
    const bundle = prototypeFixture();
    const compiled = await compileInlineWidget("react", encodePrototype(bundle), "artifact");
    expect(compiled.document).toContain("cake-widget-root");
    for (const option of bundle.options) expect(compiled.document).toContain(`${option.id} design`);
    expect(compiled.document).toContain("#123456");
    expect(compiled.document).not.toContain("not required");
  });

  it("rejects a missing manifest dependency during compilation, before rendering/publication", async () => {
    const bundle = prototypeFixture();
    bundle.shared = [];
    await expect(compileInlineWidget("react", encodePrototype(bundle), "artifact")).rejects.toThrow(
      "Missing prototype dependency",
    );
  });

  it("reports an unavailable external shared package rather than returning incomplete source", async () => {
    const bundle = prototypeFixture();
    bundle.shared[1] = {
      id: "tokens",
      source: 'export {ink} from "cake-unavailable-test-package";',
      dependencies: ["cake-unavailable-test-package"],
    };
    await expect(compileInlineWidget("react", encodePrototype(bundle), "artifact")).rejects.toThrow(
      "requires a user-installed widget package environment",
    );
  });
});
