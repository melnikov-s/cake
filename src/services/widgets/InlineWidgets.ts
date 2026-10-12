import { Context, type Effect } from "effect";
import type {
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../contracts/application/cake-rpc-contract";
import type { InlineWidgetError } from "../../contracts/widgets/inline-widgets-errors";

type CompilePayload = (typeof cakeRpcPayloadSchemas)["compile-inline-widget"]["Type"];
type CompileSuccess = (typeof cakeRpcSuccessSchemas)["compile-inline-widget"]["Type"];

export interface InlineWidgetsService {
  readonly compile: (request: CompilePayload) => Effect.Effect<CompileSuccess, InlineWidgetError>;
}

export class InlineWidgets extends Context.Service<InlineWidgets, InlineWidgetsService>()(
  "cake/services/widgets/InlineWidgets",
) {}
