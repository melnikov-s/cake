import { Context, Schema, type Effect } from "effect";
import type { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../../ipc/cake-rpc-contract";

type CompilePayload = (typeof cakeRpcPayloadSchemas)["compile-inline-widget"]["Type"];
type CompileSuccess = (typeof cakeRpcSuccessSchemas)["compile-inline-widget"]["Type"];

export class InlineWidgetError extends Schema.TaggedError<InlineWidgetError>()(
  "InlineWidgetError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface InlineWidgetsService {
  readonly compile: (request: CompilePayload) => Effect.Effect<CompileSuccess, InlineWidgetError>;
}

export class InlineWidgets extends Context.Service<InlineWidgets, InlineWidgetsService>()(
  "cake/services/widgets/InlineWidgets",
) {}
