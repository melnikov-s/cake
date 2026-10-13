import { describe, expect, it } from "vitest";
import { artifactStateWireError } from "../../../src/contracts/widgets/artifact-state-wire";

describe("artifact JSON wire boundary", () => {
  it("rejects own undefined native defaults before they become a silent save timeout", () => {
    const scene = structuredClone({ elements: [{ customData: undefined }] });
    expect(Object.hasOwn(scene.elements[0]!, "customData")).toBe(true);
    expect(artifactStateWireError(scene)).toBe(
      "value/elements/0/customData must be JSON (received undefined)",
    );
    expect(artifactStateWireError(JSON.parse(JSON.stringify(scene)))).toBeUndefined();
  });

  it("retains JSON metadata, tombstones, files and shared subobjects", () => {
    const element = { id: "shape", isDeleted: true, customData: { title: "Keep me" } };
    expect(
      artifactStateWireError({
        elements: [element, element],
        files: { image: { dataURL: "data:image/png;base64,AA==" } },
      }),
    ).toBeUndefined();
  });

  it.each([undefined, NaN, Infinity, new Map(), new Date(), [undefined], 1n, () => 1])(
    "rejects non-JSON values %s",
    (value) => {
      expect(artifactStateWireError(value)).toBeDefined();
    },
  );

  it("reports cycles rather than throwing during postMessage or serialization", () => {
    const value: { self?: object } = {};
    value.self = value;
    expect(artifactStateWireError(value)).toContain("circular reference");
  });
});
