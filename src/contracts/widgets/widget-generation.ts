import type { JsonValue } from "../serialization/json-contract";
import type { WidgetConversationOrigin } from "./widget-conversation";
import type { WidgetPreview } from "./widget-preview";
import type { WidgetBrowserOutput } from "./widget-browser-output";

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
  browser: WidgetBrowserOutput;
  /** Accepted candidate state, omitted when the branch did not change it. */
  state?: JsonValue;
}

export interface InlineWidgetRevisionRequest {
  sessionId: string;
  generationSessionId: string;
  source: string;
  brief: string;
  fallback: string;
  instructions: string;
  initialState?: JsonValue;
  /** Distinguishes empty storage from an explicitly saved null document during review. */
  initialStateVersion: number;
  model?: { provider: string; id: string };
  signal?: AbortSignal;
}
