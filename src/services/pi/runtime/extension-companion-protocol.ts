import { protocol } from "electron";
import {
  ExtensionCompanionModuleRegistry,
  type PublishedExtensionCompanionModule,
} from "./extension-companion-module-registry";

const extensionCompanionScheme = "cake-extension";
const modules = new ExtensionCompanionModuleRegistry();

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

export function handleExtensionCompanionScheme() {
  protocol.handle(extensionCompanionScheme, (request) => {
    const token = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
    const source = token ? modules.source(token) : undefined;
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

export interface ExtensionCompanionModulePublication extends PublishedExtensionCompanionModule {
  readonly url: string;
}

export function publishExtensionCompanionModule(
  source: string,
): ExtensionCompanionModulePublication {
  const publication = modules.publish(source);
  return {
    ...publication,
    url: `${extensionCompanionScheme}://module/${publication.token}`,
  };
}
