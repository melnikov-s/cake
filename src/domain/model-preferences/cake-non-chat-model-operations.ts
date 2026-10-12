import { Schema } from "effect";
import {
  NonChatModelReference,
  NonChatModelType,
  type NonChatModelPreferences,
} from "../../contracts/models/non-chat-model-data";
import type { CakeOperationDefinition } from "../../services/pi/runtime/cake-operation-registry";

const selectionInput = Schema.Struct({
  type: NonChatModelType,
  requested: Schema.optionalKey(NonChatModelReference),
});
const selectionOutput = Schema.Struct({
  type: NonChatModelType,
  source: Schema.Literals(["requested", "preference", "agent"]),
  model: Schema.NullOr(
    Schema.Struct({
      provider: NonChatModelReference.fields.provider,
      id: NonChatModelReference.fields.modelId,
    }),
  ),
});

/** Selection only: execution and request-time credentials remain Pi's native codemode responsibility. */
export function createCakeNonChatModelOperations(
  readPreferences: () => NonChatModelPreferences,
  runtime: {
    getAvailableOfType(
      type: typeof NonChatModelType.Type,
      provider: undefined,
      options: { signal: AbortSignal },
    ): Promise<ReadonlyArray<{ provider: string; id: string }>>;
  },
): CakeOperationDefinition[] {
  return [
    {
      command: "models.select-non-chat",
      topic: "models",
      summary:
        "Resolve a requested image/classifier model or the backend's advisory preference for native codemode.",
      inputSchema: selectionInput,
      outputSchema: selectionOutput,
      examples: [
        { input: { type: "image" } },
        {
          input: { type: "classifier", requested: { provider: "typesafe", modelId: "jev-latest" } },
        },
      ],
      result:
        "Structured {type, source, model}; model is {provider,id}, or null when no preference lets the agent choose. Unavailable references fail explicitly.",
      guidance: [
        "In codemode, use const {result: selected} = await tools.cake({command: 'models.select-non-chat', input: {type: 'image'}}), then pass selected.model to models.generateImages(model, {input}). Use type 'classifier' and models.classify for typed questions.",
        "Pass requested {provider,modelId} when the user explicitly asks for a model; it overrides the preference. A preference is not a restriction.",
        "When model is null, choose from native models.getAvailableOfType(type). If selection fails, report unavailable credentials/model and ask the user before substituting another billed model.",
      ],
      limitations: [
        "Does not execute a model, enable tools, classify in the background, or select a chat model.",
      ],
      async execute(input, context) {
        const decoded = await Schema.decodeUnknownPromise(selectionInput)(input);
        const reference = decoded.requested ?? readPreferences()[decoded.type];
        if (!reference) return { type: decoded.type, source: "agent", model: null };
        const available = await runtime.getAvailableOfType(decoded.type, undefined, {
          signal: context.signal,
        });
        if (
          !available.some(
            (model) => model.provider === reference.provider && model.id === reference.modelId,
          )
        )
          throw new Error(
            `${decoded.requested ? "Requested" : "Preferred"} ${decoded.type} model ${reference.provider}/${reference.modelId} is unavailable in this session. Check provider credentials or choose another model; no substitution was made.`,
          );
        return {
          type: decoded.type,
          source: decoded.requested ? "requested" : "preference",
          model: { provider: reference.provider, id: reference.modelId },
        };
      },
    },
  ];
}
