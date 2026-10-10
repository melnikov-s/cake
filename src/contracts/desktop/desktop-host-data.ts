import { Schema } from "effect";

export const DesktopHostSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({ kind: Schema.Literal("remote"), url: Schema.String }),
]);
export type DesktopHostSelection = Schema.Schema.Type<typeof DesktopHostSelection>;

export class DesktopHostError extends Schema.TaggedError<DesktopHostError>()("DesktopHostError", {
  message: Schema.String,
}) {}

/** One exact endpoint, never credentials, proxy paths, queries, or URL fragments. */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter an http, https, ws, or wss server URL");
  }
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/", "/rpc"].includes(url.pathname)
  )
    throw new Error(
      "Use a server URL without credentials, query, fragment, or a path other than /rpc",
    );
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/rpc";
  return url.href;
}
