import type { InlineWidgetLanguage } from "./inline-widget-contract";
import type { WidgetBrowserOutput } from "./widget-browser-output";

/** A skill-supplied renderer prepared before the session accepts drawing requests. */
export interface WidgetTemplate {
  readonly language: InlineWidgetLanguage;
  readonly source: string;
  readonly browser: WidgetBrowserOutput;
  readonly generationSessionId?: string;
}

export type ResolveWidgetTemplate = (skill: string) => WidgetTemplate;
