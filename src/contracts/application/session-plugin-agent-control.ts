import type { JsonValue, JsonObject } from "../serialization/json-contract";
import type { SessionPlugin } from "./application-data";
import type { InlineWidgetGenerationRequest } from "../widgets/widget-generation";

export interface SessionPluginControl {
  readonly sessionId: string;
  readonly generate: (input: InlineWidgetGenerationRequest) => Promise<{
    readonly source: string;
    readonly generationSessionId: string;
  }>;
  readonly present: (plugin: SessionPlugin) => Promise<void>;
  readonly setState: (pluginId: string, state: JsonValue) => Promise<void>;
  readonly patchState: (pluginId: string, patch: JsonObject) => Promise<void>;
  readonly delete: (pluginId: string) => Promise<void>;
}
