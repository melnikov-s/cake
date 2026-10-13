import { Context, type Effect } from "effect";
import type { WidgetBrowserOutput } from "../../contracts/widgets/widget-browser-output";
import type { InlineWidgetError } from "../../contracts/widgets/inline-widgets-errors";
import type { CompiledInlineWidgetDocument } from "./inline-widget-service";

export interface WidgetBrowserOutputsService {
  readonly retain: (
    compiled: CompiledInlineWidgetDocument,
  ) => Effect.Effect<WidgetBrowserOutput, InlineWidgetError>;
  readonly open: (
    browser: WidgetBrowserOutput,
  ) => Effect.Effect<CompiledInlineWidgetDocument, InlineWidgetError>;
}

export class WidgetBrowserOutputs extends Context.Service<
  WidgetBrowserOutputs,
  WidgetBrowserOutputsService
>()("cake/services/widgets/WidgetBrowserOutputs") {}
