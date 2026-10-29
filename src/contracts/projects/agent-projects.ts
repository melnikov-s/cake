import { Effect, Schema } from "effect";
import type { JsonValue } from "../serialization/json-contract";
import type { AgentListInput } from "../agent/agent-list-data";
import type {
  ProjectSettingsGetInput,
  ProjectSettingsUpdateInput,
} from "./project-settings-schema";

const projectPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const projectName = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(512)));

export const AgentProjectAddInput = Schema.Struct({
  path: projectPath,
  name: Schema.optionalKey(projectName),
});
export interface AgentProjectAddInput extends Schema.Schema.Type<typeof AgentProjectAddInput> {}

export const AgentProjectInfoInput = Schema.Struct({ path: projectPath });
export interface AgentProjectInfoInput extends Schema.Schema.Type<typeof AgentProjectInfoInput> {}

export const AgentProjectRenameInput = Schema.Struct({ path: projectPath, name: projectName });
export interface AgentProjectRenameInput extends Schema.Schema.Type<
  typeof AgentProjectRenameInput
> {}

export const AgentProjectRemoveInput = Schema.Struct({
  path: projectPath,
  deleteSessions: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export interface AgentProjectRemoveInput extends Schema.Schema.Type<
  typeof AgentProjectRemoveInput
> {}

/** A registered Project as reported to agents: the exact path routes later session operations. */
export interface AgentProjectView {
  readonly path: string;
  readonly name: string;
  readonly projectChatId: string;
  readonly addedAt: string;
  readonly lastOpenedAt: string;
  readonly trusted: boolean;
}

/**
 * Cake Chat's Project registry authority. Registration and renaming are main-owned; removal
 * runs through the invoking window's UI removal workflow so navigation state retires with it.
 */
export interface CakeChatProjectControl {
  list(input: AgentListInput, signal: AbortSignal): Promise<JsonValue>;
  info(input: AgentProjectInfoInput, signal: AbortSignal): Promise<JsonValue>;
  add(input: AgentProjectAddInput, signal: AbortSignal): Promise<JsonValue>;
  requestTrust(input: AgentProjectInfoInput, signal: AbortSignal): Promise<JsonValue>;
  rename(input: AgentProjectRenameInput, signal: AbortSignal): Promise<JsonValue>;
  remove(input: AgentProjectRemoveInput, signal: AbortSignal): Promise<JsonValue>;
  getSettings(input: ProjectSettingsGetInput, signal: AbortSignal): Promise<JsonValue>;
  updateSettings(input: ProjectSettingsUpdateInput, signal: AbortSignal): Promise<JsonValue>;
}
