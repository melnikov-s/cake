import { Context, type Effect } from "effect";
import type { VsCodeServerError } from "../../contracts/vscode/vs-code-server-errors";
import type { VsCodeViewBounds, VsCodeViewEndpoint } from "./VsCodeViewsRuntime";

/** Device-local native presentation; no workspace, binary or companion authority. */
export class VsCodeViews extends Context.Service<
  VsCodeViews,
  {
    readonly open: (
      connectionId: number,
      endpoint: VsCodeViewEndpoint,
    ) => Effect.Effect<void, VsCodeServerError>;
    readonly updateBounds: (
      connectionId: number,
      bounds: VsCodeViewBounds,
    ) => Effect.Effect<void, VsCodeServerError>;
    readonly focusCake: (connectionId: number) => Effect.Effect<void>;
    readonly closeForWindow: (nativeId: number) => Effect.Effect<void>;
    readonly backToAgentForWindow: (nativeId: number) => boolean;
  }
>()("cake/services/vscode/VsCodeViews") {}
