import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleInlineWidgetScheme,
  registerInlineWidgetScheme,
} from "../../../../src/services/electron/inline-widget-protocol";
import {
  handleExtensionCompanionScheme,
  registerExtensionCompanionScheme,
} from "../../../../src/services/electron/extension-companion-protocol";
import {
  publishInlineWidget,
  revokeInlineWidget,
} from "../../../../src/services/widgets/inline-widget-document-registry";
import { publishExtensionCompanionModule } from "../../../../src/services/pi/runtime/extension-companion-module-registry";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Response>(),
  registerSchemesAsPrivileged: vi.fn(),
}));

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: native.registerSchemesAsPrivileged,
    handle: (scheme: string, handler: (request: Request) => Response) =>
      native.handlers.set(scheme, handler),
  },
}));

function request(url: string) {
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
  it("preserves distinct widget and trusted extension scheme privileges", () => {
    registerInlineWidgetScheme();
    registerExtensionCompanionScheme();
    expect(native.registerSchemesAsPrivileged.mock.calls).toEqual([
      [[{ scheme: "cake-widget", privileges: { standard: true, secure: true } }]],
      [
        [
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
      const response = request(first.url);
      expect(await response.text()).toBe("<html>first</html>");
      expect(Object.fromEntries(response.headers)).toEqual({
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; img-src data: https:; media-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
      });

      revokeInlineWidget(first.token);
      revokeInlineWidget(first.token);
      expect(request(first.url).status).toBe(404);
      expect(await request(second.url).text()).toBe("<html>second</html>");
      expect(request(`cake-widget://other/${second.token}`).status).toBe(404);
      expect(request(`${second.url}/extra`).status).toBe(404);
      expect(request("cake-widget://document/not-a-token").status).toBe(404);
    } finally {
      revokeInlineWidget(first.token);
      revokeInlineWidget(second.token);
    }
    expect(request(second.url).status).toBe(404);
  });

  it("serves a shared companion until its last publishing generation releases it", async () => {
    const source = "export default function Companion() {}";
    const first = publishExtensionCompanionModule(source);
    const second = publishExtensionCompanionModule(source);
    try {
      expect(second.url).toBe(first.url);
      expect(first.url).toBe(`cake-extension://module/${first.token}`);
      const response = request(first.url);
      expect(await response.text()).toBe(source);
      expect(Object.fromEntries(response.headers)).toEqual({
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      });
      first.release();
      first.release();
      expect(await request(second.url).text()).toBe(source);
      second.release();
      expect(request(second.url).status).toBe(404);
      expect(request("cake-extension://module/missing").status).toBe(404);
    } finally {
      first.release();
      second.release();
    }
  });
});
