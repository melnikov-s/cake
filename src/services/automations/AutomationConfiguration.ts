import { Context } from "effect";

/** Backend filesystem context for global automation execution, independent of permanent chats. */
export class AutomationConfiguration extends Context.Service<
  AutomationConfiguration,
  {
    readonly homeDirectory: string;
  }
>()("cake/services/automations/AutomationConfiguration") {}
