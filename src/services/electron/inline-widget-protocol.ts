import { protocol } from "electron";
import {
  inlineWidgetResource,
  inlineWidgetScheme,
} from "../widgets/inline-widget-document-registry";
import { inlineWidgetContentSecurityPolicy } from "./inline-widget-policy";

export function registerInlineWidgetScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: inlineWidgetScheme,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export function handleInlineWidgetScheme(remoteEndpoint?: string) {
  protocol.handle(inlineWidgetScheme, async (request) => {
    const url = new URL(request.url);
    const match =
      url.hostname === "document"
        ? /^\/([0-9a-f-]{36})(?:\/(assets\/.*))?$/.exec(url.pathname)
        : null;
    if (!match) return new Response("Widget resource not found", { status: 404 });
    const token = match[1]!;
    let path: string;
    try {
      path = decodeURIComponent(match[2] ?? "");
    } catch {
      return new Response("Invalid widget resource", { status: 400 });
    }
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": inlineWidgetContentSecurityPolicy,
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    };
    if (remoteEndpoint) {
      const endpoint = new URL(remoteEndpoint);
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
      endpoint.pathname = `/widget-assets/document/${token}${path ? "/" + path : ""}`;
      endpoint.search = "";
      try {
        const response = await fetch(endpoint, {
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        return response.ok
          ? new Response(await response.arrayBuffer(), {
              headers: {
                ...headers,
                "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream",
              },
            })
          : new Response("Widget resource not found", { status: 404 });
      } catch {
        return new Response("Widget backend unavailable", { status: 503 });
      }
    }
    const resource = inlineWidgetResource(token, path);
    return resource
      ? new Response(Buffer.from(resource.data), {
          headers: { ...headers, "Content-Type": resource.contentType },
        })
      : new Response("Widget resource not found", { status: 404 });
  });
}
