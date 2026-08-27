import { protocol } from "electron";
import type { CompiledInlineWidgetDocument } from "./inline-widget-service";

const inlineWidgetScheme = "cake-widget";
const inlineWidgetContentSecurityPolicy =
  "default-src 'none'; img-src data: https:; media-src data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";

const documents = new Map<string, string>();

export function registerInlineWidgetScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: inlineWidgetScheme, privileges: { standard: true, secure: true } },
  ]);
}

export function handleInlineWidgetScheme() {
  protocol.handle(inlineWidgetScheme, (request) => {
    const url = new URL(request.url);
    const token =
      url.hostname === "document" && /^\/[0-9a-f-]{36}$/.test(url.pathname)
        ? url.pathname.slice(1)
        : undefined;
    const document = token ? documents.get(token) : undefined;
    if (!document)
      return new Response("Widget document not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    return new Response(document, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": inlineWidgetContentSecurityPolicy,
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
}

export function publishInlineWidget(compiled: CompiledInlineWidgetDocument) {
  documents.set(compiled.token, compiled.document);
  return { token: compiled.token, url: `${inlineWidgetScheme}://document/${compiled.token}` };
}
