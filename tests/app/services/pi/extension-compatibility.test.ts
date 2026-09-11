import { describe, expect, it } from "vitest";
import { createCakeExtensionUiContext } from "../../../../src/services/pi/runtime/extension-compatibility";

function createContext() {
  const diagnostics: Array<{ method: string; message: string }> = [];
  const ui = createCakeExtensionUiContext({
    request: async () => undefined,
    emitState: () => undefined,
    emitIntent: () => undefined,
    state: { statuses: [] },
    addDiagnostic: (method, message) => diagnostics.push({ method, message }),
  });
  return { ui, diagnostics };
}

describe("createCakeExtensionUiContext theme", () => {
  it("survives Pi's UI context spread without reporting degradation", () => {
    const { ui, diagnostics } = createContext();

    // Pi's extension runner wraps the UI context as `{ ...ui, select, ... }` on
    // bind, which reads every member including `theme`.
    const wrapped = { ...ui };

    expect(wrapped.theme).toBeDefined();
    expect(diagnostics).toEqual([]);
  });

  it("renders styling as plain text and reports one theme diagnostic on use", () => {
    const { ui, diagnostics } = createContext();

    expect(ui.theme.fg("accent", "styled")).toBe("styled");
    expect(ui.theme.bold("emphasis")).toBe("emphasis");
    expect(ui.theme.getFgAnsi("accent")).toBe("");
    expect(ui.theme.name).toBe("cake");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ method: "theme" });
  });
});
