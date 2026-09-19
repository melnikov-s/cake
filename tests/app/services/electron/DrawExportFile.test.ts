import { describe, expect, it } from "vitest";
import {
  decodeDrawExportData,
  drawExportExtension,
} from "../../../../src/services/electron/DrawExportFile";

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const document = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

describe("DrawExportFile", () => {
  it("validates each supported native export payload", () => {
    expect(decodeDrawExportData("png", `data:image/png;base64,${tinyPng}`)).toBeInstanceOf(
      Uint8Array,
    );
    expect(decodeDrawExportData("svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toContain(
      "<svg",
    );
    expect(decodeDrawExportData("excalidraw", document)).toBe(document);
    expect(drawExportExtension("excalidraw")).toBe(".excalidraw");
  });

  it("rejects Cake persistence envelopes renamed as editable documents", () => {
    expect(() =>
      decodeDrawExportData(
        "excalidraw",
        JSON.stringify({
          type: "cake-excalidraw",
          version: 1,
          source: "cake",
          elements: [],
          appState: {},
          files: {},
        }),
      ),
    ).toThrow("not an editable Excalidraw document");
  });
});
