import { Context } from "effect";

/** Listener-scoped presentation port; unavailable to native Electron IPC. */
export class EditorBrowserPort extends Context.Service<
  EditorBrowserPort,
  { readonly port: number | undefined; readonly publicOrigin?: string }
>()("cake/server/EditorBrowserPort") {}
