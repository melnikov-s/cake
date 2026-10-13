import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleInlineWidgetScheme } from "../../../../src/services/electron/inline-widget-protocol";
import { handleExtensionCompanionScheme } from "../../../../src/services/electron/extension-companion-protocol";
import { registerRichContentSchemes } from "../../../../src/services/electron/rich-content-protocols";
import {
  publishInlineWidget,
  revokeInlineWidget,
} from "../../../../src/services/widgets/inline-widget-document-registry";
import { publishExtensionCompanionModule } from "../../../../src/services/pi/runtime/extension-companion-module-registry";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Response | Promise<Response>>(),
  registerSchemesAsPrivileged: vi.fn(),
}));

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: native.registerSchemesAsPrivileged,
    handle: (scheme: string, handler: (request: Request) => Response | Promise<Response>) =>
      native.handlers.set(scheme, handler),
  },
}));

async function request(url: string) {
  const handler = native.handlers.get(new URL(url).protocol.slice(0, -1));
  if (!handler) throw new Error(`No handler for ${url}`);
  return handler(new Request(url));
}

beforeEach(() => {
  native.registerSchemesAsPrivileged.mockClear();
  native.handlers.clear();
  handleInlineWidgetScheme();
  handleExtensionCompanionScheme();
});

describe("desktop rich-content adapters", () => {
  it("registers both schemes in one call so Electron preserves widget fetch privileges", () => {
    registerRichContentSchemes();
    expect(native.registerSchemesAsPrivileged.mock.calls).toEqual([
      [
        [
          {
            scheme: "cake-widget",
            privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
          },
          {
            scheme: "cake-extension",
            privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
          },
        ],
      ],
    ]);
  });

  it("widget_document_revocation_is_scoped", async () => {
    const first = publishInlineWidget({ token: randomUUID(), document: "<html>first</html>" });
    const second = publishInlineWidget({ token: randomUUID(), document: "<html>second</html>" });
    try {
      expect(first.url).toBe(`cake-widget://document/${first.token}`);
      const response = await request(first.url);
      expect(await response.text()).toBe("<html>first</html>");
      expect(Object.fromEntries(response.headers)).toEqual({
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; img-src data: https: cake-widget: 'self'; media-src data: https: cake-widget: 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; font-src data: cake-widget: 'self'; connect-src data: cake-widget: 'self'; form-action 'none'; base-uri 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
      });

      revokeInlineWidget(first.token);
      revokeInlineWidget(first.token);
      expect((await request(first.url)).status).toBe(404);
      expect(await (await request(second.url)).text()).toBe("<html>second</html>");
      expect((await request(`cake-widget://other/${second.token}`)).status).toBe(404);
      expect((await request(`${second.url}/extra`)).status).toBe(404);
      expect((await request("cake-widget://document/not-a-token")).status).toBe(404);
    } finally {
      revokeInlineWidget(first.token);
      revokeInlineWidget(second.token);
    }
    expect((await request(second.url)).status).toBe(404);
  });

  it("serves a shared companion until its last publishing generation releases it", async () => {
    const source = "export default function Companion() {}";
    const first = publishExtensionCompanionModule(source);
    const second = publishExtensionCompanionModule(source);
    try {
      expect(second.url).toBe(first.url);
      expect(first.url).toBe(`cake-extension://module/${first.token}`);
      const response = await request(first.url);
      expect(await response.text()).toBe(source);
      expect(Object.fromEntries(response.headers)).toEqual({
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      });
      first.release();
      first.release();
      expect(await (await request(second.url)).text()).toBe(source);
      second.release();
      expect((await request(second.url)).status).toBe(404);
      expect((await request("cake-extension://module/missing")).status).toBe(404);
    } finally {
      first.release();
      second.release();
    }
  });
});
