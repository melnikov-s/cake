import { Option, Schema } from "effect";
import {
  compiledInlineWidgetSchema,
  type CompiledInlineWidget,
} from "../../ipc/inline-widget-contract";

/** Map only a validated, published Cake document capability on the browser origin. */
export function widgetDocumentUrl(
  compiled: CompiledInlineWidget,
  location: Pick<Location, "protocol" | "origin">,
): string | undefined {
  if (Option.isNone(Schema.decodeUnknownOption(compiledInlineWidgetSchema)(compiled)))
    return undefined;
  if (location.protocol !== "http:" && location.protocol !== "https:") return compiled.url;
  return `${location.origin}/widget-assets/document/${compiled.token}`;
}
