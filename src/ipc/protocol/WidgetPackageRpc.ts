import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  WidgetPackageError,
  WidgetPackageInstall,
  WidgetPackageRemove,
  WidgetPackageSnapshot,
} from "../../contracts/widgets/widget-packages";

export const WidgetPackageRpc = RpcGroup.make(
  Rpc.make("widgetPackages.list", {
    payload: Schema.Struct({}),
    success: WidgetPackageSnapshot,
    error: WidgetPackageError,
  }),
  Rpc.make("widgetPackages.install", {
    payload: WidgetPackageInstall,
    success: WidgetPackageSnapshot,
    error: WidgetPackageError,
  }),
  Rpc.make("widgetPackages.remove", {
    payload: WidgetPackageRemove,
    success: WidgetPackageSnapshot,
    error: WidgetPackageError,
  }),
);
