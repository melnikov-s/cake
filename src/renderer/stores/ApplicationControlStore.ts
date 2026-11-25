import type {
  WindowControlRequest,
  WindowControlResponse,
} from "../../contracts/application/window-control";
import { SESSION_ASSISTANT_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { ActivityNotice } from "../../contracts/application/activity-history";
import type { AgentActionNotice } from "../../contracts/application/agent-action-notice";
import { observable, Store, child, createStore, untracked } from "r-state-tree";
import type {
  CakeChatControlRequest,
  CakeControlTool,
} from "../../contracts/cake-chats/cake-chat-data";
import type {
  ProjectSessionControlRequest,
  ProjectSessionControlInvocation,
} from "../../contracts/project-sessions/project-session-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { AppControlBridge } from "../app-control/AppControlBridge";
import type { AgentControlSource, AppControlHost } from "../app-control/app-control-data";
import type { Client } from "../client/Client";
import { AppControlOperationStore } from "./AppControlOperationStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

type ForkSessionInvocation = Extract<ProjectSessionControlInvocation, { _tag: "ForkSession" }>;
type PresentForkSessionInvocation = Extract<
  ProjectSessionControlInvocation,
  { _tag: "PresentForkSession" }
>;
type ProjectChildSessionInvocation = Extract<
  ProjectSessionControlInvocation,
  { _tag: "ProjectChildSession" }
>;

interface ProjectControlContext {
  source: AgentControlSource;
  projectPath?: string;
}

/** Owns agent-requested Cake application controls for this renderer window. */
export class ApplicationControlStore extends Store<{
  client: Pick<Client, "cakeChats" | "projectSessions" | "application">;
  host: AppControlHost;
  operations: Pick<SessionOperationCoordinatorStore, "finish" | "start">;
  cakeChatRequests(): readonly CakeChatControlRequest[];
  projectContext(sessionId: string): ProjectControlContext;
  assistantSource?(): AgentControlSource | undefined;
  forkProjectSession(sessionId: string, invocation: ForkSessionInvocation): Promise<JsonValue>;
  presentForkSession(invocation: PresentForkSessionInvocation): Promise<JsonValue>;
  openProjectChildSession(
    parentSessionId: string,
    invocation: ProjectChildSessionInvocation,
  ): Promise<JsonValue>;
  reportProjectError(error: unknown, context: string): void;
  reportCakeChatError(error: unknown, context: string): void;
}> {
  private readonly bridge: AppControlBridge;
  private readonly acceptedCakeChatRequestIds = observable(new Set<string>());
  private readonly acceptedProjectRequestIds = observable(new Set<string>());

  constructor(props: ApplicationControlStore["props"]) {
    super(props);
    this.bridge = new AppControlBridge(props.host);
    this.effect(() => this.consumeCakeChatRequests());
  }

  @child
  get operationStore(): AppControlOperationStore {
    return createStore(AppControlOperationStore, { operations: this.props.operations });
  }

  /** Activates the always-on request owner and consumes requests already projected at mount. */
  start() {
    this.consumeCakeChatRequests();
  }

  runOperation<A>(action: () => Promise<A>): Promise<A> {
    return this.operationStore.run(action);
  }

  presentAgentAction(notice: AgentActionNotice) {
    this.props.host.presentation.showAgentAction(notice);
  }

  tools(): ReadonlyArray<CakeControlTool> {
    return this.bridge.listTools();
  }

  invoke(invocation: JsonValue, source?: AgentControlSource): Promise<JsonValue> {
    if (this.signal.aborted)
      return Promise.reject(new Error("Application controls are unavailable"));
    return this.invokeWithActivity(invocation, source, crypto.randomUUID());
  }

  private invokeWithActivity(
    invocation: JsonValue,
    source: AgentControlSource | undefined,
    id: string,
  ) {
    return this.bridge.invoke(invocation, source, async (notice: Omit<ActivityNotice, "id">) => {
      try {
        const entry = { ...notice, id, title: notice.title.slice(0, 512) };
        if (notice.detail !== undefined)
          Object.assign(entry, { detail: notice.detail.slice(0, 4_096) });
        await this.props.client.application.recordActivityNotice(entry, { signal: this.signal });
      } catch (error) {
        if (!this.signal.aborted) console.warn("[cake] Could not record Activity", error);
      }
    });
  }

  async handleWindowRequest(request: WindowControlRequest): Promise<void> {
    if (this.signal.aborted || this.acceptedProjectRequestIds.has(request.controlRequestId)) return;
    this.acceptedProjectRequestIds.add(request.controlRequestId);
    const result: WindowControlResponse = this.bridge.supports(request.invocation.name)
      ? {
          handled: true,
          result: await this.invokeWithActivity(
            request.invocation,
            request.source,
            request.controlRequestId,
          ).catch((error) => ({
            ok: false,
            command: request.invocation.name,
            error: errorMessage(error),
          })),
        }
      : { handled: false };
    if (this.signal.aborted) return;
    try {
      await this.props.client.application.respondWindowControl(
        { controlRequestId: request.controlRequestId, result },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.props.reportProjectError(error, "Window control response");
    }
  }

  async handleProjectSessionRequest(request: ProjectSessionControlRequest): Promise<void> {
    if (this.signal.aborted || this.acceptedProjectRequestIds.has(request.controlRequestId)) return;
    // Acceptance is the idempotency boundary. Retrying a failed response must not
    // repeat an application mutation after main has stopped awaiting the request.
    this.acceptedProjectRequestIds.add(request.controlRequestId);

    const result = await this.projectResult(request);
    if (this.signal.aborted) return;
    try {
      await this.props.client.projectSessions.respondControl(
        request.sessionId,
        request.controlRequestId,
        result,
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted)
        this.props.reportProjectError(error, "Project Session control response");
    }
  }

  private async projectResult(request: ProjectSessionControlRequest): Promise<JsonValue> {
    const invocation = request.invocation;
    if (invocation._tag === "ForkSession") {
      return this.props.forkProjectSession(request.sessionId, invocation).catch((error) => ({
        ok: false,
        error: errorMessage(error),
      }));
    }
    if (invocation._tag === "PresentForkSession") {
      return this.props.presentForkSession(invocation).catch((error) => ({
        ok: false,
        error: errorMessage(error),
      }));
    }
    if (invocation._tag === "ProjectChildSession") {
      return this.props.openProjectChildSession(request.sessionId, invocation).catch((error) => ({
        ok: false,
        error: errorMessage(error),
      }));
    }

    const context = this.props.projectContext(request.sessionId);
    const appInvocation =
      invocation._tag === "InvokeAppControl"
        ? { name: invocation.command, arguments: invocation.input }
        : context.projectPath
          ? {
              name:
                invocation._tag === "CreateSession" ? "sessions.create" : "sessions.create-draft",
              arguments: {
                workspacePath: context.projectPath,
                name: invocation.name,
                initialPrompt: invocation.initialPrompt,
                ...(invocation._tag === "CreateSession" && invocation.purpose
                  ? { purpose: invocation.purpose }
                  : null),
                ...(invocation._tag === "CreateSession" && invocation.todoId
                  ? { todoId: invocation.todoId }
                  : null),
                ...(invocation.model ? { model: invocation.model } : null),
                ...(invocation._tag === "CreateSession" && invocation.worktreeName !== undefined
                  ? { worktreeName: invocation.worktreeName }
                  : null),
              },
            }
          : undefined;
    if (!appInvocation)
      return {
        ok: false,
        command: invocation._tag === "CreateSession" ? "sessions.create" : "sessions.create-draft",
        error: "Cake could not find the calling Project Session.",
      };
    return this.invokeWithActivity(appInvocation, context.source, request.controlRequestId).catch(
      (error) => ({
        ok: false,
        command: appInvocation.name,
        error: errorMessage(error),
      }),
    );
  }

  private consumeCakeChatRequests() {
    for (const request of this.props.cakeChatRequests()) {
      if (this.acceptedCakeChatRequestIds.has(request.controlRequestId)) continue;
      this.acceptedCakeChatRequestIds.add(request.controlRequestId);
      untracked(() => void this.handleCakeChatRequest(request));
    }
  }

  private async handleCakeChatRequest(request: CakeChatControlRequest) {
    const chat = this.props.host.state
      .cakeChatSessions()
      .find((session) => session.sessionId === request.sessionId);
    const contextSource =
      request.sessionId === SESSION_ASSISTANT_ID && request.invocation.name.startsWith("vscode.")
        ? this.props.assistantSource?.()
        : undefined;
    const result = await this.invokeWithActivity(
      request.invocation,
      contextSource ?? {
        kind: "cake-chat",
        sessionId: request.sessionId,
        ...(chat?.projectPath
          ? { projectPath: chat.projectPath, workingDirectory: chat.projectPath }
          : null),
        title:
          this.props.host.state
            .cakeChatSessions()
            .find((session) => session.sessionId === request.sessionId)?.title ?? "Cake Chat",
      },
      request.controlRequestId,
    ).catch((error) => ({
      ok: false,
      command: request.invocation.name,
      error: errorMessage(error),
    }));
    if (this.signal.aborted) return;
    try {
      await this.props.client.cakeChats.respondControl(request.controlRequestId, result, {
        signal: this.signal,
      });
    } catch (error) {
      if (!this.signal.aborted)
        this.props.reportCakeChatError(
          error,
          `Cake Chat control response: ${request.invocation.name}`,
        );
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
