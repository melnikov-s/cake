import { describe, expect, it } from "vitest";
import { ExtensionCompanionModuleRegistry } from "../../../../src/services/pi/runtime/extension-companion-module-registry";

describe("ExtensionCompanionModuleRegistry", () => {
  it("retains shared sources until every publication is released", () => {
    const registry = new ExtensionCompanionModuleRegistry();
    const first = registry.publish("export default 1");
    const second = registry.publish("export default 1");

    expect(second.token).toBe(first.token);
    expect(registry.source(first.token)).toBe("export default 1");

    first.release();
    expect(registry.source(first.token)).toBe("export default 1");

    second.release();
    expect(registry.source(first.token)).toBeUndefined();
  });

  it("does not revoke another publication when one release is repeated", () => {
    const registry = new ExtensionCompanionModuleRegistry();
    const publication = registry.publish("export default 2");
    const retained = registry.publish("export default 2");

    publication.release();
    publication.release();

    expect(registry.source(retained.token)).toBe("export default 2");
    retained.release();
    expect(registry.source(retained.token)).toBeUndefined();
  });
});
