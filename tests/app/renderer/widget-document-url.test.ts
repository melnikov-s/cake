import { expect, it } from "vitest";
import { widgetDocumentUrl } from "../../../src/renderer/lib/widget-document-url";

const token = "00000000-0000-4000-8000-000000000001";
const compiled = { token, url: `cake-widget://document/${token}` };

it("maps only matching published capabilities on a browser origin", () => {
  const browser = { protocol: "http:", origin: "http://127.0.0.1:8020" };
  expect(widgetDocumentUrl(compiled, browser)).toBe(
    `${browser.origin}/widget-assets/document/${token}`,
  );
  expect(widgetDocumentUrl(compiled, { protocol: "file:", origin: "null" })).toBe(compiled.url);
  expect(
    widgetDocumentUrl({ ...compiled, url: "https://other.example/steal" }, browser),
  ).toBeUndefined();
  expect(widgetDocumentUrl({ ...compiled, token: "../../../rpc" }, browser)).toBeUndefined();
  expect(
    widgetDocumentUrl(
      { ...compiled, url: `cake-widget://document/${crypto.randomUUID()}` },
      browser,
    ),
  ).toBeUndefined();
});
