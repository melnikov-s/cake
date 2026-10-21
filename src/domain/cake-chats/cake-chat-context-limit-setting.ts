import { Option, Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { CakeChatContextStatus } from "../../contracts/cake-chats/context-policy";
import type { JsonValue } from "../../contracts/serialization/json-contract";

const CONTEXT_LIMIT_KEY = "cakeChat.contextLimitTokens";

const JsonRecord = Schema.Record(Schema.String, Schema.Json);
const SettingResult = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.String,
  value: JsonRecord,
});

/**
 * A permanent chat knows its own model window, so its settings.get/update results for the
 * context limit also report this chat's actual limit after the model-window minimum.
 */
export function withChatContextLimit(
  operations: readonly CakeOperationDefinition[],
  contextStatus: () => Promise<JsonValue>,
): CakeOperationDefinition[] {
  return operations.map((operation) =>
    operation.command !== "settings.get" && operation.command !== "settings.update"
      ? operation
      : {
          ...operation,
          async execute(input, context) {
            const result = await operation.execute(input, context);
            const decoded = Schema.decodeUnknownOption(SettingResult)(result);
            if (Option.isNone(decoded) || decoded.value.value.key !== CONTEXT_LIMIT_KEY)
              return result;
            const effective = Schema.decodeUnknownOption(JsonRecord)(decoded.value.value.effective);
            if (Option.isNone(effective)) return result;
            const status = Schema.decodeUnknownOption(CakeChatContextStatus)(await contextStatus());
            if (Option.isNone(status)) return result;
            const { limitTokens, configuredLimitTokens, modelLimitTokens } = status.value;
            return {
              ...decoded.value,
              value: {
                ...decoded.value.value,
                effective: {
                  ...effective.value,
                  thisChat: { limitTokens, configuredLimitTokens, modelLimitTokens },
                },
              },
            };
          },
        },
  );
}
