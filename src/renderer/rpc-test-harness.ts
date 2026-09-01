import { Effect, Option, Schema, Stream } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import { FoundationFailure } from "../ipc/protocol/CakeRpc";
import {
  nativeCommandSchema,
  type NativeCommand,
  type NativeCommandResult,
  type NativeCommandType,
} from "../ipc/native-contract";
import { makeRendererRuntime } from "./RendererRuntime";

const bridge = window.cake;
if (!bridge) throw new Error("Cake preload bridge is unavailable");

const runtime = makeRendererRuntime(bridge.rpc);
const withClient = <Success, Failure>(
  operation: (client: CakeIpcClientService) => Effect.Effect<Success, Failure>,
) => Effect.flatMap(CakeIpcClient, operation);
const run = <Success, Failure>(
  effect: Effect.Effect<Success, Failure, CakeIpcClient>,
  signal?: AbortSignal,
) => runtime.runPromise(effect, signal ? { signal } : undefined);
const collect = <Value, Failure>(
  stream: Stream.Stream<Value, Failure, CakeIpcClient>,
): Promise<ReadonlyArray<Value>> => run(Stream.runCollect(stream));

const TaggedFailure = Schema.Struct({ _tag: Schema.String });
let delayController: AbortController | undefined;
let runningDelay: Promise<void> | undefined;
let runningStream: Promise<ReadonlyArray<number>> | undefined;

type RoutedNativeCommand = Extract<NativeCommand, { type: NativeCommandType }>;
const widenNativeCommandResult = (response: NativeCommandResult): NativeCommandResult => response;

const routeGroups = {
  electron: new Set<string>([
    "choose-project",
    "open-external-url",
    "show-transcript-selection-context-menu",
    "show-composer-context-menu",
    "show-session-context-menu",
    "show-project-context-menu",
    "set-fullscreen-surface-open",
  ]),
  filesystem: new Set<string>(["choose-attachments", "suggest-files", "read-workspace-file"]),
  workspaces: new Set<string>([
    "reword-composer-selection",
    "generate-session-title",
    "set-utility-model",
    "register-project",
    "rename-project",
    "remove-project",
    "delete-session",
    "set-session-unread",
    "restart-pi",
    "inspect-workspace",
    "respond-workspace-trust",
  ]),
  managedWorktrees: new Set<string>([
    "create-worktree",
    "get-worktree-status",
    "land-worktree",
    "discard-worktree",
  ]),
  terminals: new Set<string>([
    "open-terminal",
    "write-terminal",
    "resize-terminal",
    "get-terminal-status",
    "close-terminal",
  ]),
  vscode: new Set<string>([
    "get-embedded-editor-state",
    "set-vscode-server-path",
    "install-embedded-editor",
    "open-embedded-editor",
    "update-embedded-editor-bounds",
    "reveal-in-embedded-editor",
    "open-embedded-editor-source-control",
    "update-embedded-editor-annotations",
  ]),
  artifacts: new Set<string>(["respond-artifact", "respond-ui", "export-artifacts"]),
  plugins: new Set<string>([
    "get-customization-state",
    "get-plugin-authoring-reference",
    "list-plugin-files",
    "create-plugin",
    "read-plugin-file",
    "write-plugin-file",
    "validate-customization",
    "activate-customization",
    "rollback-customization",
    "use-factory-customization",
    "list-plugins",
    "set-plugin-enabled",
    "set-active-scene",
    "delete-plugin",
    "compile-inline-widget",
    "repair-inline-widget",
    "open-plugin-agent",
    "prompt-plugin-agent",
    "abort-plugin-agent",
    "detach-plugin-agent",
    "run-plugin-completion",
    "cancel-plugin-completion",
    "load-plugin-state",
    "save-plugin-state",
    "call-plugin-backend",
    "cancel-plugin-backend-call",
    "customization-rendered",
    "customization-runtime-failed",
  ]),
} as const;

function routeGroup(type: NativeCommandType): keyof typeof routeGroups | undefined {
  if (routeGroups.electron.has(type)) return "electron";
  if (routeGroups.filesystem.has(type)) return "filesystem";
  if (routeGroups.workspaces.has(type)) return "workspaces";
  if (routeGroups.managedWorktrees.has(type)) return "managedWorktrees";
  if (routeGroups.terminals.has(type)) return "terminals";
  if (routeGroups.vscode.has(type)) return "vscode";
  if (routeGroups.artifacts.has(type)) return "artifacts";
  if (routeGroups.plugins.has(type)) return "plugins";
  return undefined;
}

const harness = {
  invokeNative: (input: NativeCommand) => {
    const parsed = Schema.decodeUnknownSync(nativeCommandSchema)(input);
    return run(
      withClient((client) => {
        const request: RoutedNativeCommand = parsed;
        const group = routeGroup(request.type);
        if (!group) throw new Error(`The RPC test harness cannot invoke ${parsed.type}`);
        const { type: _type, ...payload } = request;
        const commands = {
          ...client.electron,
          ...client.filesystem,
          ...client.workspaces,
          ...client.managedWorktrees,
          ...client.terminals,
          ...client.vscode,
          ...client.artifacts,
          ...client.plugins,
        };
        // SAFETY: nativeCommandSchema correlates the route discriminant and payload;
        // this smoke-only dynamic dispatcher preserves that validated pair.
        return commands[request.type](payload as never).pipe(Effect.map(widenNativeCommandResult));
      }),
    );
  },
  getHomeDirectory: () => run(withClient((client) => client.application.getHomeDirectory())),
  getApplicationState: () => run(withClient((client) => client.application.getState())),
  listModels: () => run(withClient((client) => client.models.list())),
  listModelPresets: () => run(withClient((client) => client.modelPresets.list())),
  listProjectSessions: () => run(withClient((client) => client.projectSessions.list())),
  listCakeChats: () => run(withClient((client) => client.cakeChats.list())),
  invokeElectronProbe: () =>
    run(
      withClient((client) =>
        client.electron["set-fullscreen-surface-open"]({
          requestId: crypto.randomUUID(),
          surfaceId: crypto.randomUUID(),
          open: false,
        }),
      ),
    ),
  nativeReady: () =>
    collect(
      Stream.unwrap(Effect.map(CakeIpcClient, (client) => client.events.application())).pipe(
        Stream.take(1),
      ),
    ).then(([event]) => event),
  listDiscussionSessions: () =>
    run(
      withClient((client) =>
        client.discussionSessions.list({
          workingDirectory: "/tmp/cake-effect-rpc",
          parentSessionId: "rpc-empty-parent",
        }),
      ),
    ),
  createModelPreset: (input: {
    name: string;
    provider: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    fastMode: boolean;
  }) => run(withClient((client) => client.modelPresets.create(input))),
  updateModelPreset: (input: {
    id: string;
    name: string;
    provider: string;
    modelId: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    fastMode: boolean;
  }) => run(withClient((client) => client.modelPresets.update(input))),
  removeModelPreset: (id: string) => run(withClient((client) => client.modelPresets.remove(id))),
  setDefaultModelPreset: (id?: string) =>
    run(withClient((client) => client.modelPresets.setDefault(id))),
  async resolveModelPresetFailureTag(id: string) {
    try {
      await run(withClient((client) => client.modelPresets.resolve(id)));
      return "success";
    } catch (error) {
      const failure = Schema.decodeUnknownOption(TaggedFailure)(error);
      return Option.isSome(failure) ? failure.value._tag : "unknown";
    }
  },
  async typedFailureTag() {
    try {
      await run(withClient((client) => client.foundation.typedFailure()));
      return "success";
    } catch (error) {
      return Schema.is(FoundationFailure)(error) ? error._tag : "unknown";
    }
  },
  stream: (count: number, intervalMs: number) =>
    collect(
      Stream.unwrap(
        Effect.map(CakeIpcClient, (client) => client.foundation.stream({ count, intervalMs })),
      ),
    ),
  startDelay(durationMs: number) {
    delayController = new AbortController();
    runningDelay = run(
      withClient((client) => client.foundation.delay({ durationMs })),
      delayController.signal,
    );
    void runningDelay.catch(() => {});
  },
  cancelDelay() {
    delayController?.abort();
  },
  async waitForDelay() {
    try {
      await runningDelay;
      return "completed";
    } catch {
      return "interrupted";
    }
  },
  startStream(count: number, intervalMs: number) {
    runningStream = collect(
      Stream.unwrap(
        Effect.map(CakeIpcClient, (client) => client.foundation.stream({ count, intervalMs })),
      ),
    );
    void runningStream.catch(() => {});
  },
  activeRequests: () => run(withClient((client) => client.foundation.activeRequests())),
};

Reflect.set(globalThis, "cakeRpcHarness", harness);
window.addEventListener("pagehide", () => {
  void runtime.dispose();
});
document.documentElement.dataset.rpcReady = "true";
