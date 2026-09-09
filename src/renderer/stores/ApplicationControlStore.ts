import { Store, child, createStore, untracked } from "r-state-tree";
import type { CakeChatControlRequest, CakeControlTool } from "../../domain/cake-chat-data";
import type {
  ProjectSessionControlRequest,
  ProjectSessionControlInvocation,
} from "../../domain/project-session-data";
import type { JsonValue } from "../../ipc/json-contract";
import {
  AppControlBridge,
  type AgentControlSource,
  type AppControlHost,
} from "../app-control/AppControlBridge";
import type { Client } from "../client/Client";
import { AppControlOperationStore } from "./AppControlOperationStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

type ForkSessionInvocation = Extract<ProjectSessionControlInvocation, { _tag: "ForkSession" }>;
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
  client: Pick<Client, "cakeChats" | "projectSessions">;
  host: AppControlHost;
  operations: Pick<SessionOperationCoordinatorStore, "finish" | "start">;
  cakeChatRequests(): readonly CakeChatControlRequest[];
  projectContext(sessionId: string): ProjectControlContext;
  forkProjectSession(sessionId: string, invocation: ForkSessionInvocation): Promise<JsonValue>;
  openProjectChildSession(
    parentSessionId: string,
    invocation: ProjectChildSessionInvocation,
  ): Promise<JsonValue>;
  reportProjectError(error: unknown, context: string): void;
  reportCakeChatError(error: unknown, context: string): void;
}> {
  private readonly bridge: AppControlBridge;
  private readonly acceptedCakeChatRequestIds = new Set<string>();
  private readonly acceptedProjectRequestIds = new Set<string>();

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

  tools(): ReadonlyArray<CakeControlTool> {
    return this.bridge.listTools();
  }

  invoke(invocation: JsonValue, source?: AgentControlSource): Promise<JsonValue> {
    if (this.signal.aborted)
      return Promise.reject(new Error("Application controls are unavailable"));
    return this.bridge.invoke(invocation, source);
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
        name: invocation._tag === "CreateSession" ? "sessions.create" : "sessions.create-draft",
        error: "Cake could not find the calling Project Session.",
      };
    return this.bridge.invoke(appInvocation, context.source).catch((error) => ({
      ok: false,
      name: appInvocation.name,
      error: errorMessage(error),
    }));
  }

  private consumeCakeChatRequests() {
    for (const request of this.props.cakeChatRequests()) {
      if (this.acceptedCakeChatRequestIds.has(request.controlRequestId)) continue;
      this.acceptedCakeChatRequestIds.add(request.controlRequestId);
      untracked(() => void this.handleCakeChatRequest(request));
    }
  }

  private async handleCakeChatRequest(request: CakeChatControlRequest) {
    const result = await this.bridge
      .invoke(request.invocation, {
        kind: "cake-chat",
        sessionId: request.sessionId,
        title:
          this.props.host.state
            .cakeChatSessions()
            .find((session) => session.sessionId === request.sessionId)?.title ?? "Cake Chat",
      })
      .catch((error) => ({
        ok: false,
        name: request.invocation.name,
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
