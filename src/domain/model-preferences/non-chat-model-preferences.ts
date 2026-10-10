import { Effect } from "effect";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { NonChatModelPreferenceUpdate } from "../../services/storage/non-chat-model-data";

/** Advisory references, not provider configuration or execution restrictions. */
export const updateNonChatModelPreference = Effect.fn("nonChatModels.updatePreference")(function* (
  input: NonChatModelPreferenceUpdate,
) {
  const application = yield* ApplicationState;
  const state = yield* application.transact((current) => {
    const preferences = { ...current.nonChatModelPreferences };
    if (input.preference === null) delete preferences[input.type];
    else preferences[input.type] = input.preference;
    return Effect.succeed({ ...current, nonChatModelPreferences: preferences });
  });
  return state.nonChatModelPreferences ?? {};
});
