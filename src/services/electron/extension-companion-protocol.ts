import { protocol } from "electron";
import {
  extensionCompanionModuleSource,
  extensionCompanionScheme,
} from "../pi/runtime/extension-companion-module-registry";

export function registerExtensionCompanionScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: extensionCompanionScheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function handleExtensionCompanionScheme(remoteEndpoint?: string) {
  protocol.handle(extensionCompanionScheme, (request) => {
    const url = new URL(request.url);
    const token =
      url.hostname === "module" && /^\/[0-9a-f]{64}$/.test(url.pathname)
        ? url.pathname.slice(1)
        : undefined;
    if (token && remoteEndpoint) {
      const endpoint = new URL(remoteEndpoint);
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
      endpoint.pathname = `/widget-assets/module/${token}`;
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
                  "Content-Type": "text/javascript; charset=utf-8",
                  "Access-Control-Allow-Origin": "*",
                  "Cache-Control": "no-store",
                },
              })
            : new Response("Extension companion module not found", { status: 404 }),
        )
        .catch(() => new Response("Widget backend unavailable", { status: 503 }));
    }
    const source = token ? extensionCompanionModuleSource(token) : undefined;
    if (!source)
      return new Response("Extension companion module not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    return new Response(source, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  });
}
