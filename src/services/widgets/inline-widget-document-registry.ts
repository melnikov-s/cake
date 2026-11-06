import type { CompiledInlineWidgetDocument } from "./inline-widget-service";
import { withInlineWidgetLinks } from "./inline-widget-links";

export const inlineWidgetScheme = "cake-widget";

// One process-local publication authority shared by producers and host adapters.
// Documents are transient; revocation removes only the specified capability.
const documents = new Map<string, CompiledInlineWidgetDocument>();

export function publishInlineWidget(compiled: CompiledInlineWidgetDocument) {
  documents.set(compiled.token, {
    ...compiled,
    document: withInlineWidgetLinks(compiled.document, compiled.token),
  });
  return { token: compiled.token, url: `${inlineWidgetScheme}://document/${compiled.token}` };
}

export function inlineWidgetDocument(token: string): string | undefined {
  return documents.get(token)?.document;
}

/** Exact snapshot resources only: never a filesystem path or a package resolver. */
export function inlineWidgetResource(token: string, path: string) {
  const compiled = documents.get(token);
  if (!compiled) return undefined;
  if (path === "")
    return { data: Buffer.from(compiled.document), contentType: "text/html; charset=utf-8" };
  return compiled.assets?.find((asset) => asset.path === path);
}

/** Releases one transient compiled capability without disturbing mounted published widgets. */
export function revokeInlineWidget(token: string) {
  documents.delete(token);
}
