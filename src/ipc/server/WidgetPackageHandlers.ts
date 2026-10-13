import { Effect } from "effect";
import { WidgetPackages } from "../../services/widgets/WidgetPackages";
import { WidgetPackageRpc } from "../protocol/WidgetPackageRpc";

export const widgetPackageHandlers = WidgetPackageRpc.of({
  "widgetPackages.list": () => Effect.flatMap(WidgetPackages, (packages) => packages.list()),
  "widgetPackages.install": ({ specifier }) =>
    Effect.flatMap(WidgetPackages, (packages) => packages.install(specifier)),
  "widgetPackages.remove": ({ name }) =>
    Effect.flatMap(WidgetPackages, (packages) => packages.remove(name)),
});
