import { protocol } from "electron";
import {
  inlineWidgetDocument,
  inlineWidgetScheme,
} from "../widgets/inline-widget-document-registry";
import { inlineWidgetContentSecurityPolicy } from "./inline-widget-policy";

export function registerInlineWidgetScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: inlineWidgetScheme, privileges: { standard: true, secure: true } },
  ]);
}

export function handleInlineWidgetScheme(remoteEndpoint?: string) {
  protocol.handle(inlineWidgetScheme, (request) => {
    const url = new URL(request.url);
    const token =
      url.hostname === "document" && /^\/[0-9a-f-]{36}$/.test(url.pathname)
        ? url.pathname.slice(1)
        : undefined;
    if (token && remoteEndpoint) {
      const endpoint = new URL(remoteEndpoint);
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
      endpoint.pathname = `/widget-assets/document/${token}`;
      endpoint.search = "";
      return fetch(endpoint, {
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      })
        .then(async (response) =>
          response.ok
            ? new Response(await response.text(), {
                headers: {
                  "Cache-Control": "no-store",
                  "Content-Security-Policy": inlineWidgetContentSecurityPolicy,
                  "Content-Type": "text/html; charset=utf-8",
                  "Referrer-Policy": "no-referrer",
                },
              })
            : new Response("Widget document not found", { status: 404 }),
        )
        .catch(() => new Response("Widget backend unavailable", { status: 503 }));
    }
    const document = token ? inlineWidgetDocument(token) : undefined;
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
