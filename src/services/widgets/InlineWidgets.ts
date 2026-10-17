import { Context, type Effect } from "effect";
import type {
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../contracts/application/cake-rpc-contract";
import type { InlineWidgetError } from "../../contracts/widgets/inline-widgets-errors";

type CompilePayload = (typeof cakeRpcPayloadSchemas)["compile-inline-widget"]["Type"];
type CompileSuccess = (typeof cakeRpcSuccessSchemas)["compile-inline-widget"]["Type"];

export interface InlineWidgetsService {
  readonly compile: (
    owner: number,
    request: CompilePayload,
  ) => Effect.Effect<CompileSuccess, InlineWidgetError>;
  readonly open: (
    owner: number,
    request: (typeof cakeRpcPayloadSchemas)["open-widget-browser"]["Type"],
  ) => Effect.Effect<CompileSuccess, InlineWidgetError>;
  readonly release: (owner: number, token: string) => Effect.Effect<void>;
  readonly releaseConnection: (owner: number) => Effect.Effect<void>;
}

export class InlineWidgets extends Context.Service<InlineWidgets, InlineWidgetsService>()(
  "cake/services/widgets/InlineWidgets",
) {}
