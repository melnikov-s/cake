import { Context, type Effect } from "effect";
import type {
  WidgetPackageError,
  WidgetPackageSnapshot,
} from "../../contracts/widgets/widget-packages";

export interface WidgetPackagesService {
  readonly directory: string;
  readonly list: () => Effect.Effect<WidgetPackageSnapshot, WidgetPackageError>;
  readonly install: (specifier: string) => Effect.Effect<WidgetPackageSnapshot, WidgetPackageError>;
  readonly remove: (name: string) => Effect.Effect<WidgetPackageSnapshot, WidgetPackageError>;
}

export class WidgetPackages extends Context.Service<WidgetPackages, WidgetPackagesService>()(
  "cake/services/widgets/WidgetPackages",
) {}
