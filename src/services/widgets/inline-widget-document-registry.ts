import type { CompiledInlineWidgetDocument } from "./inline-widget-service";

export const inlineWidgetScheme = "cake-widget";

// One process-local publication authority shared by producers and host adapters.
// Documents are transient; revocation removes only the specified capability.
const documents = new Map<string, string>();

export function publishInlineWidget(compiled: CompiledInlineWidgetDocument) {
  documents.set(compiled.token, compiled.document);
  return { token: compiled.token, url: `${inlineWidgetScheme}://document/${compiled.token}` };
}

export function inlineWidgetDocument(token: string): string | undefined {
  return documents.get(token);
}

/** Releases one transient compiled capability without disturbing mounted published widgets. */
export function revokeInlineWidget(token: string) {
  documents.delete(token);
}
