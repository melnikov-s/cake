import { Schema } from "effect";
import { CakeControlTool } from "../../contracts/cake-chats/cake-chat-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type {
  AgentControlSource,
  AppControlCommand,
  AppControlHost,
  AppControlResult,
  SessionSummaryView,
} from "./app-control-data";
import { knownSession } from "./control-projections";

export interface ControlContext {
  host: AppControlHost;
  source?: AgentControlSource;
}

export type ControlScope = "global" | "session-assistant" | "internal";
type ControlExecution = { result: AppControlResult } | { value: JsonValue };

export interface RegisteredControl {
  command: string;
  scope: ControlScope;
  tool(): CakeControlTool | undefined;
  invoke(untrustedInput: unknown, context: ControlContext): Promise<ControlExecution>;
}

type ControlDiscovery = Pick<CakeControlTool, "topic" | "summary"> &
  Partial<Omit<CakeControlTool, "command" | "parameters" | "topic" | "summary">>;

type ControlMetadata =
  | { scope: "internal"; discovery?: never; discoveryArgs?: never }
  | {
      scope: "global" | "session-assistant";
      discovery: ControlDiscovery;
      discoveryArgs?: Schema.Constraint;
    };

type ControlDefinition<
  Command extends AppControlCommand,
  Args extends Schema.ConstraintDecoder<unknown, never>,
> = {
  command: Command;
  args: Args;
  run(input: Args["Type"], context: ControlContext, command: Command): Promise<AppControlResult>;
} & ControlMetadata;

/** Capture input decoding and its typed handler before erasing the type for map dispatch.
 * Definitions are renderer-local adapters; their handlers do not own Store workflows.
 */
export function defineControl<
  const Command extends AppControlCommand,
  Args extends Schema.ConstraintDecoder<unknown, never>,
>(definition: ControlDefinition<Command, Args>): RegisteredControl {
  const invocation = Schema.Struct({
    name: Schema.Literal(definition.command),
    arguments: Schema.Unknown,
  });
  const decode = Schema.decodeUnknownPromise(invocation);
  return {
    command: definition.command,
    scope: definition.scope,
    tool: () =>
      definition.discovery
        ? Schema.decodeUnknownSync(CakeControlTool)({
            examples: [],
            result: "A bounded authoritative Cake application result.",
            ...definition.discovery,
            command: definition.command,
            parameters: Schema.toStandardJSONSchemaV1(definition.discoveryArgs ?? definition.args)[
              "~standard"
            ].jsonSchema.input({ target: "draft-07" }),
          })
        : undefined,
    async invoke(untrustedInput, context) {
      const decoded = await decode(untrustedInput);
      const input = await Schema.decodeUnknownPromise(definition.args)(decoded.arguments);
      return { result: await definition.run(input, context, definition.command) };
    },
  };
}

/** All explicitly targeted Project Session controls validate the same live catalog
 * before invoking a capability. Keep this gate when adding or reorganizing commands.
 */
export function defineSessionControl<
  const Command extends AppControlCommand,
  Args extends Schema.ConstraintDecoder<{ readonly sessionId: string }, never>,
>(
  definition: ControlMetadata & {
    command: Command;
    args: Args;
    run(
      input: Args["Type"],
      context: ControlContext,
      command: Command,
      session: SessionSummaryView,
    ): Promise<AppControlResult>;
  },
): RegisteredControl {
  return defineControl({
    ...definition,
    async run(input, context, command) {
      const session = knownSession(context.host, input.sessionId);
      if (!session) return { ok: false, command, error: "Cake could not find that session." };
      return definition.run(input, context, command, session);
    },
  });
}
