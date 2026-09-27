import { Context, type Effect } from "effect";
import type {
  DesktopHostError,
  DesktopHostSelection,
} from "../../domain/application/desktop-host-data";

export class DesktopHost extends Context.Service<
  DesktopHost,
  {
    readonly current: () => DesktopHostSelection;
    readonly select: (selection: DesktopHostSelection) => Effect.Effect<boolean, DesktopHostError>;
  }
>()("cake/services/electron/DesktopHost") {}
