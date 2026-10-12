import type { JsonValue } from "../serialization/json-contract";
import type { WidgetConversationOrigin } from "./widget-conversation";
import type { WidgetPreview } from "./widget-preview";

export interface InlineWidgetGenerationRequest {
  sessionId: string;
  parentConversation: WidgetConversationOrigin;
  brief: string;
  data?: unknown;
  initialState?: JsonValue;
  fallback: string;
  surface?: "widget" | "session-plugin";
  model?: { provider: string; id: string };
  signal?: AbortSignal;
}

export interface InlineWidgetGenerationResult {
  language: "react";
  source: string;
  generationSessionId: string;
  preview: WidgetPreview;
}

export interface InlineWidgetRevisionRequest {
  sessionId: string;
  generationSessionId: string;
  source: string;
  brief: string;
  fallback: string;
  instructions: string;
  model?: { provider: string; id: string };
  signal?: AbortSignal;
}
