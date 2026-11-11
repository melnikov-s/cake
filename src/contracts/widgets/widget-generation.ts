import type { InlineWidgetLanguage } from "./inline-widget-contract";
import type { JsonValue } from "../serialization/json-contract";
import type { WidgetConversationOrigin } from "./widget-conversation";
import type { WidgetPreview } from "./widget-preview";
import type { WidgetBrowserOutput } from "./widget-browser-output";

/** Live progress of one widget side chat, reported to the calling tool while it runs. */
export interface WidgetGenerationProgress {
  phase: "building" | "repairing" | "revising" | "compiling" | "rendering" | "reviewing";
  /** Widget file paths written so far. */
  files: string[];
  /** Total characters across those files. */
  characters: number;
}

export interface InlineWidgetGenerationRequest {
  sessionId: string;
  /** Regular Pi sessions branch their context; permanent chats build privately from the brief. */
  parentConversation?: WidgetConversationOrigin;
  brief: string;
  /** Defaults to React; HTML is a self-contained document without dependency bundling. */
  language?: InlineWidgetLanguage;
  data?: unknown;
  initialState?: JsonValue;
  fallback: string;
  model?: { provider: string; id: string };
  signal?: AbortSignal;
  onProgress?(progress: WidgetGenerationProgress): void;
}

export interface InlineWidgetGenerationResult {
  language: InlineWidgetLanguage;
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
  language: InlineWidgetLanguage;
  source: string;
  brief: string;
  fallback: string;
  instructions: string;
  initialState?: JsonValue;
  /** Distinguishes empty storage from an explicitly saved null document during review. */
  initialStateVersion: number;
  model?: { provider: string; id: string };
  signal?: AbortSignal;
  onProgress?(progress: WidgetGenerationProgress): void;
}
