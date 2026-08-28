import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../ipc/json-contract";
import type { GlobalSessionSummary, ProjectRecord, SessionSummary } from "../ipc/session-contract";
import {
  customizationStateSchema,
  pluginIdSchema,
  pluginStatusSchema,
  type CustomizationState,
  type PluginDiagnostic,
  type PluginStatus,
} from "../plugin/plugin-contract";

const sessionIdTargetSchema = z.object({ sessionId: z.string().min(1).max(256) }).strict();
const sessionNavigationTargetSchema = sessionIdTargetSchema.extend({
  messageId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Optional transcript message ID to reveal after opening the session."),
});

const emptyArgumentsSchema = z.object({}).strict();
const pluginStatusesSchema = z.array(pluginStatusSchema).max(1_000);
const pluginFileSchema = z
  .object({
    pluginId: pluginIdSchema,
    path: z.string().min(1).max(8_192).describe("Path relative to the plugin directory."),
  })
  .strict();
const appControlArgumentSchemas = {
  get_app_state: emptyArgumentsSchema,
  get_customization_state: emptyArgumentsSchema,
  get_plugin_authoring_reference: emptyArgumentsSchema,
  list_plugin_files: emptyArgumentsSchema,
  create_plugin: z
    .object({
      pluginId: pluginIdSchema,
      name: z.string().trim().min(1).max(128),
      renderer: z.boolean().default(true),
      backend: z.boolean().default(false),
      scene: z.boolean().default(false),
      expectedWorkingRevision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  read_plugin_file: pluginFileSchema,
  write_plugin_file: pluginFileSchema.extend({
    content: z.string().max(2_000_000),
    expectedWorkingRevision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  validate_customization: z
    .object({
      expectedBaseRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      expectedSourceRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      request: z.string().trim().min(1).max(8_192),
    })
    .strict(),
  activate_customization: z
    .object({
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      expectedSourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
      request: z.string().trim().min(1).max(8_192),
    })
    .strict(),
  rollback_customization: emptyArgumentsSchema,
  use_factory_customization: emptyArgumentsSchema,
  set_plugin_enabled: z.object({ pluginId: pluginIdSchema, enabled: z.boolean() }).strict(),
  set_active_scene: z.object({ pluginId: pluginIdSchema.optional() }).strict(),
  get_session_status: sessionIdTargetSchema,
  open_session: sessionNavigationTargetSchema,
  create_session: z.object({ workspacePath: z.string().min(1).max(4_096) }).strict(),
  send_session_message: sessionIdTargetSchema.extend({
    text: z.string().trim().min(1).max(100_000),
    delivery: z.enum(["prompt", "follow-up", "steer"]).optional(),
  }),
  abort_session: sessionIdTargetSchema,
  rename_session: sessionIdTargetSchema.extend({ title: z.string().trim().min(1).max(500) }),
  set_session_resolved: sessionIdTargetSchema.extend({ resolved: z.boolean() }),
  set_sessions_resolved: z
    .object({
      sessionIds: z.array(z.string().min(1).max(256)).min(1).max(10_000),
      resolved: z.boolean(),
    })
    .strict(),
  set_cake_chat_sessions_resolved: z
    .object({
      sessionIds: z.array(z.string().min(1).max(256)).min(1).max(10_000),
      resolved: z.boolean(),
    })
    .strict(),
  set_session_model: sessionIdTargetSchema.extend({
    provider: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(200),
  }),
} as const;

function invocation<Name extends keyof typeof appControlArgumentSchemas>(name: Name) {
  return z.object({ name: z.literal(name), arguments: appControlArgumentSchemas[name] }).strict();
}

const appControlInvocationSchema = z.discriminatedUnion("name", [
  invocation("get_app_state"),
  invocation("get_customization_state"),
  invocation("get_plugin_authoring_reference"),
  invocation("list_plugin_files"),
  invocation("create_plugin"),
  invocation("read_plugin_file"),
  invocation("write_plugin_file"),
  invocation("validate_customization"),
  invocation("activate_customization"),
  invocation("rollback_customization"),
  invocation("use_factory_customization"),
  invocation("set_plugin_enabled"),
  invocation("set_active_scene"),
  invocation("get_session_status"),
  invocation("open_session"),
  invocation("create_session"),
  invocation("send_session_message"),
  invocation("abort_session"),
  invocation("rename_session"),
  invocation("set_session_resolved"),
  invocation("set_sessions_resolved"),
  invocation("set_cake_chat_sessions_resolved"),
  invocation("set_session_model"),
]);

type AppControlInvocation = z.infer<typeof appControlInvocationSchema>;

export interface AppControlHost {
  currentSession(): { workspacePath: string; sessionId: string } | undefined;
  projects(): readonly ProjectRecord[];
  sessions(): readonly GlobalSessionSummary[];
  cakeChatSessions(): readonly SessionSummary[];
  sessionActivity(sessionId: string): "running" | "unread" | undefined;
  openSession(sessionId: string, messageId?: string): Promise<boolean | void>;
  createSession(workspacePath: string): Promise<void>;
  sendSessionMessage(
    sessionId: string,
    text: string,
    delivery: "prompt" | "follow-up" | "steer",
  ): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  setSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  setSessionsResolved(sessionIds: readonly string[], resolved: boolean): Promise<number>;
  setCakeChatSessionsResolved(sessionIds: readonly string[], resolved: boolean): Promise<number>;
  setSessionModel(sessionId: string, provider: string, modelId: string): Promise<void>;
  customizationState(): CustomizationState | undefined;
  plugins(): readonly PluginStatus[];
  getPluginAuthoringReference(): Promise<string>;
  listPluginFiles(): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  createPlugin(input: {
    pluginId: string;
    name: string;
    renderer: boolean;
    backend: boolean;
    scene: boolean;
    expectedWorkingRevision: string;
  }): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  readPluginFile(pluginId: string, path: string): Promise<string>;
  writePluginFile(
    pluginId: string,
    path: string,
    content: string,
    expectedWorkingRevision: string,
  ): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  validateCustomization(
    expectedBaseRevision: string | undefined,
    request: string,
    expectedSourceRevision?: string,
  ): Promise<{
    revision: string;
    sourceRevision: string;
    diagnostics: PluginDiagnostic[];
    valid: boolean;
  }>;
  activateCustomization(
    revision: string,
    expectedSourceRevision: string,
    request: string,
  ): Promise<{ revision: string; activating: true }>;
  rollbackCustomization(): Promise<CustomizationState>;
  useFactoryCustomization(): Promise<CustomizationState>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<readonly PluginStatus[]>;
  setActiveScene(pluginId?: string): Promise<readonly PluginStatus[]>;
}

export interface AppControlSession {
  workspacePath: string;
  workspaceName: string;
  sessionId: string;
  title: string;
  modified: string;
  messageCount: number;
  resolved: boolean;
  activity?: "running" | "unread";
}

export interface AppControlState {
  currentSession?: { workspacePath: string; sessionId: string };
  projectCount: number;
  sessionCount: number;
  projects: Array<{ path: string; name: string; sessionCount: number }>;
  attentionSessions: AppControlSession[];
  recentSessions: AppControlSession[];
}

export type AppControlResult =
  | { ok: true; name: "get_app_state"; state: AppControlState }
  | {
      ok: true;
      name: "get_customization_state";
      state?: CustomizationState;
      plugins: readonly PluginStatus[];
    }
  | { ok: true; name: "get_plugin_authoring_reference"; reference: string }
  | {
      ok: true;
      name: "list_plugin_files" | "create_plugin" | "write_plugin_file";
      workingRevision: string;
      buildRevision: string;
      files: string[];
    }
  | { ok: true; name: "read_plugin_file"; pluginId: string; path: string; content: string }
  | {
      ok: true;
      name: "validate_customization";
      revision: string;
      sourceRevision: string;
      diagnostics: PluginDiagnostic[];
      valid: boolean;
    }
  | { ok: true; name: "activate_customization"; revision: string; activating: true }
  | {
      ok: true;
      name: "rollback_customization" | "use_factory_customization";
      state: CustomizationState;
    }
  | { ok: true; name: "set_plugin_enabled" | "set_active_scene"; plugins: readonly PluginStatus[] }
  | {
      ok: true;
      name: "get_session_status";
      session: AppControlSession;
      selected: boolean;
      status: "running" | "unread" | "idle";
    }
  | { ok: true; name: "open_session"; opened: SessionTarget & { messageId?: string } }
  | { ok: true; name: "create_session"; workspacePath: string; status: "creating" }
  | {
      ok: true;
      name: "send_session_message";
      target: SessionTarget;
      delivery: "prompt" | "follow-up" | "steer";
      status: "sent";
    }
  | { ok: true; name: "abort_session"; target: SessionTarget; status: "stopping" }
  | { ok: true; name: "rename_session"; target: SessionTarget; title: string }
  | { ok: true; name: "set_session_resolved"; target: SessionTarget; resolved: boolean }
  | {
      ok: true;
      name: "set_sessions_resolved";
      sessionIds: string[];
      resolved: boolean;
      sessionCount: number;
    }
  | {
      ok: true;
      name: "set_cake_chat_sessions_resolved";
      sessionIds: string[];
      resolved: boolean;
      sessionCount: number;
    }
  | {
      ok: true;
      name: "set_session_model";
      target: SessionTarget;
      provider: string;
      modelId: string;
      status: "changing";
    }
  | {
      ok: true;
      command: "sessions.list";
      name: "sessions.list";
      sessions: AppControlSession[];
      attentionSessions: AppControlSession[];
    }
  | {
      ok: true;
      command: "sessions.resolve";
      name: "sessions.resolve";
      targets: Array<{ kind: "project" | "cake-chat"; sessionId: string }>;
      resolved: boolean;
      sessionCount: number;
    }
  | { ok: false; name: AppControlInvocation["name"]; error: string };

interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}

const recentSessionLimit = 20;

const sessionResolutionSchema = z
  .object({
    targets: z
      .array(
        z.object({
          kind: z.enum(["project", "cake-chat"]),
          sessionId: z.string().min(1).max(256),
        }),
      )
      .min(1)
      .max(10_000),
    resolved: z.boolean(),
  })
  .strict();

const modelControlOperations = [
  operation(
    "app.state",
    "app",
    "Inspect Cake's current selection and bounded project and session summaries.",
    appControlArgumentSchemas.get_app_state,
  ),
  operation(
    "sessions.list",
    "sessions",
    "List bounded recent and attention-worthy project sessions.",
    emptyArgumentsSchema,
  ),
  operation(
    "sessions.info",
    "sessions",
    "Inspect one explicitly targeted project session.",
    appControlArgumentSchemas.get_session_status,
  ),
  operation(
    "sessions.open",
    "sessions",
    "Open one explicitly targeted project session, optionally at a specific transcript message.",
    appControlArgumentSchemas.open_session,
  ),
  operation(
    "sessions.create",
    "sessions",
    "Create and open a session in a known project.",
    appControlArgumentSchemas.create_session,
  ),
  operation(
    "sessions.send",
    "sessions",
    "Send a message to one explicitly targeted session without opening it.",
    appControlArgumentSchemas.send_session_message,
  ),
  operation(
    "sessions.abort",
    "sessions",
    "Stop one explicitly targeted running session.",
    appControlArgumentSchemas.abort_session,
  ),
  operation(
    "sessions.resolve",
    "sessions",
    "Idempotently resolve or restore explicit project or Cake Chat targets.",
    sessionResolutionSchema,
  ),
  operation(
    "customizations.state",
    "customizations",
    "Inspect exact customization revisions, recovery diagnostics, and plugin status.",
    appControlArgumentSchemas.get_customization_state,
  ),
  operation(
    "customizations.authoring-reference",
    "customizations",
    "Read the exact version-matched authoring reference. Always do this before changing plugin source.",
    appControlArgumentSchemas.get_plugin_authoring_reference,
  ),
  operation(
    "customizations.files",
    "customizations",
    "List plugin-owned files and exact optimistic revisions.",
    appControlArgumentSchemas.list_plugin_files,
  ),
  operation(
    "customizations.create-plugin",
    "customizations",
    "Create a strict plugin manifest and starter modules.",
    appControlArgumentSchemas.create_plugin,
  ),
  operation(
    "customizations.read-file",
    "customizations",
    "Read one plugin-owned text file.",
    appControlArgumentSchemas.read_plugin_file,
  ),
  operation(
    "customizations.write-file",
    "customizations",
    "Write one plugin-owned file with optimistic revision validation.",
    appControlArgumentSchemas.write_plugin_file,
  ),
  operation(
    "customizations.validate",
    "customizations",
    "Typecheck and bundle exact plugin source without activation.",
    appControlArgumentSchemas.validate_customization,
  ),
  operation(
    "customizations.activate",
    "customizations",
    "Activate one validated unchanged customization revision.",
    appControlArgumentSchemas.activate_customization,
  ),
  operation(
    "customizations.rollback",
    "customizations",
    "Roll back to the retained last-known-good customization.",
    appControlArgumentSchemas.rollback_customization,
  ),
  operation(
    "customizations.use-factory",
    "customizations",
    "Use immutable factory UI while preserving editable source and persistence.",
    appControlArgumentSchemas.use_factory_customization,
  ),
  operation(
    "customizations.set-plugin-enabled",
    "customizations",
    "Enable or disable one exact plugin while preserving source and persistence.",
    appControlArgumentSchemas.set_plugin_enabled,
  ),
  operation(
    "customizations.set-active-scene",
    "customizations",
    "Select an enabled plugin scene or Cake's default scene.",
    appControlArgumentSchemas.set_active_scene,
  ),
] as const;

const commandToLegacyName = {
  "app.state": "get_app_state",
  "sessions.info": "get_session_status",
  "sessions.open": "open_session",
  "sessions.create": "create_session",
  "sessions.send": "send_session_message",
  "sessions.abort": "abort_session",
  "customizations.state": "get_customization_state",
  "customizations.authoring-reference": "get_plugin_authoring_reference",
  "customizations.files": "list_plugin_files",
  "customizations.create-plugin": "create_plugin",
  "customizations.read-file": "read_plugin_file",
  "customizations.write-file": "write_plugin_file",
  "customizations.validate": "validate_customization",
  "customizations.activate": "activate_customization",
  "customizations.rollback": "rollback_customization",
  "customizations.use-factory": "use_factory_customization",
  "customizations.set-plugin-enabled": "set_plugin_enabled",
  "customizations.set-active-scene": "set_active_scene",
} as const;

function operation(command: string, topic: string, summary: string, schema: z.ZodType) {
  return {
    command,
    topic,
    summary,
    guidance:
      topic === "customizations"
        ? [
            "Read customizations.authoring-reference before changing plugin source, then inspect files and revisions, validate until clean, and activate only the completed valid revision.",
            "Ordinary widgets are renderer plugins; create or select a scene only when the user explicitly requests whole-application replacement.",
          ]
        : undefined,
    parameters: z.toJSONSchema(schema, { io: "input", target: "draft-7" }),
    examples: [],
    result: "A bounded authoritative Cake application result.",
  };
}

export class AppControlBridge {
  constructor(private readonly host: AppControlHost) {}

  listTools() {
    return modelControlOperations.map((definition) => ({
      ...definition,
      parameters: jsonObjectSchema.parse(definition.parameters),
    }));
  }

  getAppState(): AppControlState {
    const sessions = this.sortedSessions();
    const state = {
      projectCount: this.host.projects().length,
      sessionCount: sessions.length,
      projects: this.host.projects().map((project) => ({
        path: project.path,
        name: project.name,
        sessionCount: sessions.filter((session) => session.workspacePath === project.path).length,
      })),
      attentionSessions: sessions
        .filter((session) => this.host.sessionActivity(session.id))
        .map((session) => this.toControlSession(session)),
      recentSessions: sessions
        .slice(0, recentSessionLimit)
        .map((session) => this.toControlSession(session)),
    };
    const currentSession = this.host.currentSession();
    return currentSession ? { ...state, currentSession } : state;
  }

  async invoke(untrustedInput: unknown): Promise<AppControlResult> {
    const gatewayInvocation = z
      .object({ name: z.string(), arguments: jsonObjectSchema })
      .strict()
      .parse(untrustedInput);
    if (gatewayInvocation.name === "sessions.list") {
      const state = this.getAppState();
      return toStrictJson({
        ok: true,
        command: "sessions.list",
        name: "sessions.list",
        sessions: state.recentSessions,
        attentionSessions: state.attentionSessions,
      });
    }
    if (gatewayInvocation.name === "sessions.resolve") {
      const input = sessionResolutionSchema.parse(gatewayInvocation.arguments);
      const projectIds = input.targets
        .filter((target) => target.kind === "project")
        .map((target) => target.sessionId);
      const cakeChatIds = input.targets
        .filter((target) => target.kind === "cake-chat")
        .map((target) => target.sessionId);
      const unknownProject = projectIds.find((sessionId) => !this.knownSession(sessionId));
      if (unknownProject)
        return {
          ok: false,
          name: "set_sessions_resolved",
          error: `Cake could not find session ${unknownProject}.`,
        };
      const knownCakeChatIds = new Set(this.host.cakeChatSessions().map((session) => session.id));
      const unknownCakeChat = cakeChatIds.find((sessionId) => !knownCakeChatIds.has(sessionId));
      if (unknownCakeChat)
        return {
          ok: false,
          name: "set_cake_chat_sessions_resolved",
          error: `Cake could not find Cake Chat session ${unknownCakeChat}.`,
        };
      const [projectCount, cakeChatCount] = await Promise.all([
        projectIds.length
          ? this.host.setSessionsResolved([...new Set(projectIds)], input.resolved)
          : 0,
        cakeChatIds.length
          ? this.host.setCakeChatSessionsResolved([...new Set(cakeChatIds)], input.resolved)
          : 0,
      ]);
      return toStrictJson({
        ok: true,
        command: "sessions.resolve",
        name: "sessions.resolve",
        targets: input.targets,
        resolved: input.resolved,
        sessionCount: projectCount + cakeChatCount,
      });
    }
    const legacyName = Object.entries(commandToLegacyName).find(
      ([command]) => command === gatewayInvocation.name,
    )?.[1];
    const invocation = appControlInvocationSchema.parse(
      legacyName ? { name: legacyName, arguments: gatewayInvocation.arguments } : gatewayInvocation,
    );
    if (invocation.name === "get_app_state")
      return { ok: true, name: invocation.name, state: this.getAppState() };
    if (invocation.name === "get_customization_state") {
      const state = this.host.customizationState();
      const result = {
        ok: true,
        name: invocation.name,
        plugins: toStrictJson(pluginStatusesSchema.parse(this.host.plugins())),
      } as const;
      return state === undefined
        ? result
        : { ...result, state: toStrictJson(customizationStateSchema.parse(state)) };
    }
    if (invocation.name === "get_plugin_authoring_reference")
      return {
        ok: true,
        name: invocation.name,
        reference: await this.host.getPluginAuthoringReference(),
      };
    if (invocation.name === "list_plugin_files")
      return { ok: true, name: invocation.name, ...(await this.host.listPluginFiles()) };
    if (invocation.name === "create_plugin")
      return {
        ok: true,
        name: invocation.name,
        ...(await this.host.createPlugin(invocation.arguments)),
      };
    if (invocation.name === "read_plugin_file")
      return {
        ok: true,
        name: invocation.name,
        pluginId: invocation.arguments.pluginId,
        path: invocation.arguments.path,
        content: await this.host.readPluginFile(
          invocation.arguments.pluginId,
          invocation.arguments.path,
        ),
      };
    if (invocation.name === "write_plugin_file")
      return {
        ok: true,
        name: invocation.name,
        ...(await this.host.writePluginFile(
          invocation.arguments.pluginId,
          invocation.arguments.path,
          invocation.arguments.content,
          invocation.arguments.expectedWorkingRevision,
        )),
      };
    if (invocation.name === "validate_customization")
      return {
        ok: true,
        name: invocation.name,
        ...(await this.host.validateCustomization(
          invocation.arguments.expectedBaseRevision,
          invocation.arguments.request,
          invocation.arguments.expectedSourceRevision,
        )),
      };
    if (invocation.name === "activate_customization")
      return {
        ok: true,
        name: invocation.name,
        ...(await this.host.activateCustomization(
          invocation.arguments.revision,
          invocation.arguments.expectedSourceRevision,
          invocation.arguments.request,
        )),
      };
    if (invocation.name === "rollback_customization")
      return {
        ok: true,
        name: invocation.name,
        state: toStrictJson(
          customizationStateSchema.parse(await this.host.rollbackCustomization()),
        ),
      };
    if (invocation.name === "use_factory_customization")
      return {
        ok: true,
        name: invocation.name,
        state: toStrictJson(
          customizationStateSchema.parse(await this.host.useFactoryCustomization()),
        ),
      };
    if (invocation.name === "set_plugin_enabled")
      return {
        ok: true,
        name: invocation.name,
        plugins: toStrictJson(
          pluginStatusesSchema.parse(
            await this.host.setPluginEnabled(
              invocation.arguments.pluginId,
              invocation.arguments.enabled,
            ),
          ),
        ),
      };
    if (invocation.name === "set_active_scene")
      return {
        ok: true,
        name: invocation.name,
        plugins: toStrictJson(
          pluginStatusesSchema.parse(await this.host.setActiveScene(invocation.arguments.pluginId)),
        ),
      };
    if (invocation.name === "create_session")
      return this.createSession(invocation.arguments.workspacePath);
    if (invocation.name === "set_sessions_resolved")
      return this.setSessionsResolved(invocation.arguments);
    if (invocation.name === "set_cake_chat_sessions_resolved")
      return this.setCakeChatSessionsResolved(invocation.arguments);

    const { sessionId } = invocation.arguments;
    const known = this.knownSession(sessionId);
    if (!known)
      return { ok: false, name: invocation.name, error: "Cake could not find that session." };
    const { workspacePath } = known;
    const target = { workspacePath, sessionId };

    if (invocation.name === "get_session_status") {
      const activity = this.host.sessionActivity(sessionId);
      const current = this.host.currentSession();
      return {
        ok: true,
        name: invocation.name,
        session: this.toControlSession(known),
        selected: current?.workspacePath === workspacePath && current.sessionId === sessionId,
        status: activity ?? "idle",
      };
    }
    if (invocation.name === "open_session") {
      const { messageId } = invocation.arguments;
      const messageFound = messageId
        ? await this.host.openSession(sessionId, messageId)
        : await this.host.openSession(sessionId);
      if (messageId && messageFound === false)
        return {
          ok: false,
          name: invocation.name,
          error: `Cake could not find message ${messageId} in that session.`,
        };
      return {
        ok: true,
        name: invocation.name,
        opened: messageId ? { ...target, messageId } : target,
      };
    }
    if (invocation.name === "send_session_message") {
      const delivery =
        invocation.arguments.delivery ??
        (this.host.sessionActivity(sessionId) === "running" ? "follow-up" : "prompt");
      await this.host.sendSessionMessage(sessionId, invocation.arguments.text, delivery);
      return { ok: true, name: invocation.name, target, delivery, status: "sent" };
    }
    if (invocation.name === "abort_session") {
      if (this.host.sessionActivity(sessionId) !== "running") {
        return {
          ok: false,
          name: invocation.name,
          error: "That session is not currently running.",
        };
      }
      await this.host.abortSession(sessionId);
      return { ok: true, name: invocation.name, target, status: "stopping" };
    }
    if (invocation.name === "rename_session") {
      await this.host.renameSession(sessionId, invocation.arguments.title);
      return { ok: true, name: invocation.name, target, title: invocation.arguments.title };
    }
    if (invocation.name === "set_session_resolved") {
      await this.host.setSessionResolved(sessionId, invocation.arguments.resolved);
      return { ok: true, name: invocation.name, target, resolved: invocation.arguments.resolved };
    }
    await this.host.setSessionModel(
      sessionId,
      invocation.arguments.provider,
      invocation.arguments.modelId,
    );
    return {
      ok: true,
      name: invocation.name,
      target,
      provider: invocation.arguments.provider,
      modelId: invocation.arguments.modelId,
      status: "changing",
    };
  }

  private sortedSessions() {
    return [...this.host.sessions()].sort((left, right) =>
      right.modified.localeCompare(left.modified),
    );
  }

  private knownSession(sessionId: string) {
    return this.host.sessions().find((session) => session.id === sessionId);
  }

  private async createSession(workspacePath: string): Promise<AppControlResult> {
    if (!this.host.projects().some((project) => project.path === workspacePath)) {
      return { ok: false, name: "create_session", error: "Cake could not find that project." };
    }
    await this.host.createSession(workspacePath);
    return { ok: true, name: "create_session", workspacePath, status: "creating" };
  }

  private async setSessionsResolved({
    sessionIds,
    resolved,
  }: z.infer<typeof appControlArgumentSchemas.set_sessions_resolved>): Promise<AppControlResult> {
    const unknown = sessionIds.find((sessionId) => !this.knownSession(sessionId));
    if (unknown)
      return {
        ok: false,
        name: "set_sessions_resolved",
        error: `Cake could not find session ${unknown}.`,
      };
    const uniqueSessionIds = [...new Set(sessionIds)];
    const sessionCount = await this.host.setSessionsResolved(uniqueSessionIds, resolved);
    return {
      ok: true,
      name: "set_sessions_resolved",
      sessionIds: uniqueSessionIds,
      resolved,
      sessionCount,
    };
  }

  private async setCakeChatSessionsResolved({
    sessionIds,
    resolved,
  }: z.infer<
    typeof appControlArgumentSchemas.set_cake_chat_sessions_resolved
  >): Promise<AppControlResult> {
    const knownIds = new Set(this.host.cakeChatSessions().map((session) => session.id));
    const unknown = sessionIds.find((sessionId) => !knownIds.has(sessionId));
    if (unknown)
      return {
        ok: false,
        name: "set_cake_chat_sessions_resolved",
        error: `Cake could not find Cake Chat session ${unknown}.`,
      };
    const uniqueSessionIds = [...new Set(sessionIds)];
    const sessionCount = await this.host.setCakeChatSessionsResolved(uniqueSessionIds, resolved);
    return {
      ok: true,
      name: "set_cake_chat_sessions_resolved",
      sessionIds: uniqueSessionIds,
      resolved,
      sessionCount,
    };
  }

  private toControlSession(session: GlobalSessionSummary): AppControlSession {
    const activity = this.host.sessionActivity(session.id);
    const result = {
      workspacePath: session.workspacePath,
      workspaceName: session.workspaceName,
      sessionId: session.id,
      title: session.title,
      modified: session.modified,
      messageCount: session.messageCount,
      resolved: session.resolved,
    };
    return activity ? { ...result, activity } : result;
  }
}

function toStrictJson<T>(value: T): T {
  // SAFETY: callers pass schema-validated JSON-shaped data; the round trip only removes properties whose value is undefined.
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value))) as T;
}
