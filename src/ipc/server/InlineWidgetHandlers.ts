import { Effect } from "effect";
import { InlineWidgets } from "../../services/widgets/InlineWidgets";
import { InlineWidgetRpc } from "../protocol/InlineWidgetRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const withOwner = <A, E>(
  operation: (owner: number, widgets: typeof InlineWidgets.Service) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) =>
    Effect.flatMap(InlineWidgets, (widgets) => operation(connectionId, widgets)),
  );

export const inlineWidgetHandlers = InlineWidgetRpc.of({
  "widgets.release": ({ token }) => withOwner((owner, widgets) => widgets.release(owner, token)),
  "widgets.open-widget-browser": (request) =>
    withOwner((owner, widgets) => widgets.open(owner, request)),
  "widgets.compile-inline-widget": (request) =>
    withOwner((owner, widgets) => widgets.compile(owner, request)),
});
