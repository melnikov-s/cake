import type { CompletionChat } from "../../contracts/pi/model-data";
import type { ProviderRequestObservation } from "../../contracts/pi/request-observation";
import type { CakeChatPreferences } from "../../contracts/application/application-data";
import type { ExplicitCakeModelSelection } from "../../contracts/model-presets/cake-model-selection";

/** Cake-owned preferences and utility-completion port; no Pi SDK values cross it. */
export interface CakeChatMemoryOptions {
  preferences(): CakeChatPreferences;
  summarize(input: {
    instructions: string;
    context: string;
    signal: AbortSignal;
    tools?: CompletionChat["tools"];
    previous?: CompletionChat["previous"];
    observeRequest?: ProviderRequestObservation;
    /** Cake Chat's current configuration, used when the summarization model is Inherit. */
    caller?: ExplicitCakeModelSelection;
  }): Promise<string>;
}
