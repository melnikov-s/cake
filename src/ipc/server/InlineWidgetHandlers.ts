import { Effect } from "effect";
import { InlineWidgets } from "../../services/widgets/InlineWidgets";
import { InlineWidgetRpc } from "../protocol/InlineWidgetRpc";

export const inlineWidgetHandlers = InlineWidgetRpc.of({
  "widgets.compile-inline-widget": (request) =>
    Effect.flatMap(InlineWidgets, (widgets) => widgets.compile(request)),
  "widgets.repair-inline-widget": (request) =>
    Effect.flatMap(InlineWidgets, (widgets) => widgets.repair(request)),
});
