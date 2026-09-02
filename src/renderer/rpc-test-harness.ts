import { Effect, Option, Schema, Stream } from "effect";
import { CakeIpcClient, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import { FoundationFailure } from "../ipc/protocol/CakeRpc";
import type { JsonObject } from "../ipc/json-contract";
import { cakeRpcPayloadSchemas } from "../ipc/cake-rpc-contract";
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

function invokeSmokeCommand(
  client: CakeIpcClientService,
  type: string,
  payload: JsonObject,
): Effect.Effect<unknown, unknown> {
  switch (type) {
    case "choose-project":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["choose-project"])(payload).pipe(
        Effect.flatMap(client.electron["choose-project"]),
      );
    case "open-external-url":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["open-external-url"])(payload).pipe(
        Effect.flatMap(client.electron["open-external-url"]),
      );
    case "show-transcript-selection-context-menu":
      return Schema.decodeUnknownEffect(
        cakeRpcPayloadSchemas["show-transcript-selection-context-menu"],
      )(payload).pipe(Effect.flatMap(client.electron["show-transcript-selection-context-menu"]));
    case "show-composer-context-menu":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["show-composer-context-menu"])(
        payload,
      ).pipe(Effect.flatMap(client.electron["show-composer-context-menu"]));
    case "show-session-context-menu":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["show-session-context-menu"])(
        payload,
      ).pipe(Effect.flatMap(client.electron["show-session-context-menu"]));
    case "show-project-context-menu":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["show-project-context-menu"])(
        payload,
      ).pipe(Effect.flatMap(client.electron["show-project-context-menu"]));
    case "set-fullscreen-surface-open":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["set-fullscreen-surface-open"])(
        payload,
      ).pipe(Effect.flatMap(client.electron["set-fullscreen-surface-open"]));
    case "choose-attachments":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["choose-attachments"])(payload).pipe(
        Effect.flatMap(client.filesystem["choose-attachments"]),
      );
    case "suggest-files":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["suggest-files"])(payload).pipe(
        Effect.flatMap(client.filesystem["suggest-files"]),
      );
    case "read-workspace-file":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["read-workspace-file"])(payload).pipe(
        Effect.flatMap(client.filesystem["read-workspace-file"]),
      );
    case "reword-composer-selection":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["reword-composer-selection"])(
        payload,
      ).pipe(Effect.flatMap(client.workspaces["reword-composer-selection"]));
    case "generate-session-title":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["generate-session-title"])(
        payload,
      ).pipe(Effect.flatMap(client.workspaces["generate-session-title"]));
    case "set-utility-model":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["set-utility-model"])(payload).pipe(
        Effect.flatMap(client.workspaces["set-utility-model"]),
      );
    case "load-staged-slash-commands":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["load-staged-slash-commands"])(
        payload,
      ).pipe(Effect.flatMap(client.workspaces["load-staged-slash-commands"]));
    case "register-project":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["register-project"])(payload).pipe(
        Effect.flatMap(client.workspaces["register-project"]),
      );
    case "rename-project":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["rename-project"])(payload).pipe(
        Effect.flatMap(client.workspaces["rename-project"]),
      );
    case "remove-project":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["remove-project"])(payload).pipe(
        Effect.flatMap(client.workspaces["remove-project"]),
      );
    case "delete-session":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["delete-session"])(payload).pipe(
        Effect.flatMap(client.workspaces["delete-session"]),
      );
    case "set-session-unread":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["set-session-unread"])(payload).pipe(
        Effect.flatMap(client.workspaces["set-session-unread"]),
      );
    case "restart-pi":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["restart-pi"])(payload).pipe(
        Effect.flatMap(client.workspaces["restart-pi"]),
      );
    case "inspect-workspace":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["inspect-workspace"])(payload).pipe(
        Effect.flatMap(client.workspaces["inspect-workspace"]),
      );
    case "respond-workspace-trust":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["respond-workspace-trust"])(
        payload,
      ).pipe(Effect.flatMap(client.workspaces["respond-workspace-trust"]));
    case "create-worktree":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["create-worktree"])(payload).pipe(
        Effect.flatMap(client.managedWorktrees["create-worktree"]),
      );
    case "get-worktree-status":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["get-worktree-status"])(payload).pipe(
        Effect.flatMap(client.managedWorktrees["get-worktree-status"]),
      );
    case "land-worktree":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["land-worktree"])(payload).pipe(
        Effect.flatMap(client.managedWorktrees["land-worktree"]),
      );
    case "discard-worktree":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["discard-worktree"])(payload).pipe(
        Effect.flatMap(client.managedWorktrees["discard-worktree"]),
      );
    case "open-terminal":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["open-terminal"])(payload).pipe(
        Effect.flatMap(client.terminals["open-terminal"]),
      );
    case "write-terminal":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["write-terminal"])(payload).pipe(
        Effect.flatMap(client.terminals["write-terminal"]),
      );
    case "resize-terminal":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["resize-terminal"])(payload).pipe(
        Effect.flatMap(client.terminals["resize-terminal"]),
      );
    case "get-terminal-status":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["get-terminal-status"])(payload).pipe(
        Effect.flatMap(client.terminals["get-terminal-status"]),
      );
    case "close-terminal":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["close-terminal"])(payload).pipe(
        Effect.flatMap(client.terminals["close-terminal"]),
      );
    case "get-embedded-editor-state":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["get-embedded-editor-state"])(
        payload,
      ).pipe(Effect.flatMap(client.vscode["get-embedded-editor-state"]));
    case "set-vscode-server-path":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["set-vscode-server-path"])(
        payload,
      ).pipe(Effect.flatMap(client.vscode["set-vscode-server-path"]));
    case "install-embedded-editor":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["install-embedded-editor"])(
        payload,
      ).pipe(Effect.flatMap(client.vscode["install-embedded-editor"]));
    case "open-embedded-editor":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["open-embedded-editor"])(
        payload,
      ).pipe(Effect.flatMap(client.vscode["open-embedded-editor"]));
    case "update-embedded-editor-bounds":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["update-embedded-editor-bounds"])(
        payload,
      ).pipe(Effect.flatMap(client.vscode["update-embedded-editor-bounds"]));
    case "reveal-in-embedded-editor":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["reveal-in-embedded-editor"])(
        payload,
      ).pipe(Effect.flatMap(client.vscode["reveal-in-embedded-editor"]));
    case "open-embedded-editor-source-control":
      return Schema.decodeUnknownEffect(
        cakeRpcPayloadSchemas["open-embedded-editor-source-control"],
      )(payload).pipe(Effect.flatMap(client.vscode["open-embedded-editor-source-control"]));
    case "update-embedded-editor-annotations":
      return Schema.decodeUnknownEffect(
        cakeRpcPayloadSchemas["update-embedded-editor-annotations"],
      )(payload).pipe(Effect.flatMap(client.vscode["update-embedded-editor-annotations"]));
    case "respond-artifact":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["respond-artifact"])(payload).pipe(
        Effect.flatMap(client.artifacts["respond-artifact"]),
      );
    case "respond-ui":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["respond-ui"])(payload).pipe(
        Effect.flatMap(client.artifacts["respond-ui"]),
      );
    case "export-artifacts":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["export-artifacts"])(payload).pipe(
        Effect.flatMap(client.artifacts["export-artifacts"]),
      );
    case "get-customization-state":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["get-customization-state"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["get-customization-state"]));
    case "get-plugin-authoring-reference":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["get-plugin-authoring-reference"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["get-plugin-authoring-reference"]));
    case "list-plugin-files":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["list-plugin-files"])(payload).pipe(
        Effect.flatMap(client.plugins["list-plugin-files"]),
      );
    case "create-plugin":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["create-plugin"])(payload).pipe(
        Effect.flatMap(client.plugins["create-plugin"]),
      );
    case "read-plugin-file":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["read-plugin-file"])(payload).pipe(
        Effect.flatMap(client.plugins["read-plugin-file"]),
      );
    case "write-plugin-file":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["write-plugin-file"])(payload).pipe(
        Effect.flatMap(client.plugins["write-plugin-file"]),
      );
    case "validate-customization":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["validate-customization"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["validate-customization"]));
    case "activate-customization":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["activate-customization"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["activate-customization"]));
    case "rollback-customization":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["rollback-customization"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["rollback-customization"]));
    case "use-factory-customization":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["use-factory-customization"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["use-factory-customization"]));
    case "list-plugins":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["list-plugins"])(payload).pipe(
        Effect.flatMap(client.plugins["list-plugins"]),
      );
    case "set-plugin-enabled":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["set-plugin-enabled"])(payload).pipe(
        Effect.flatMap(client.plugins["set-plugin-enabled"]),
      );
    case "set-active-scene":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["set-active-scene"])(payload).pipe(
        Effect.flatMap(client.plugins["set-active-scene"]),
      );
    case "delete-plugin":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["delete-plugin"])(payload).pipe(
        Effect.flatMap(client.plugins["delete-plugin"]),
      );
    case "compile-inline-widget":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["compile-inline-widget"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["compile-inline-widget"]));
    case "repair-inline-widget":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["repair-inline-widget"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["repair-inline-widget"]));
    case "open-plugin-agent":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["open-plugin-agent"])(payload).pipe(
        Effect.flatMap(client.plugins["open-plugin-agent"]),
      );
    case "prompt-plugin-agent":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["prompt-plugin-agent"])(payload).pipe(
        Effect.flatMap(client.plugins["prompt-plugin-agent"]),
      );
    case "abort-plugin-agent":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["abort-plugin-agent"])(payload).pipe(
        Effect.flatMap(client.plugins["abort-plugin-agent"]),
      );
    case "detach-plugin-agent":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["detach-plugin-agent"])(payload).pipe(
        Effect.flatMap(client.plugins["detach-plugin-agent"]),
      );
    case "run-plugin-completion":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["run-plugin-completion"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["run-plugin-completion"]));
    case "cancel-plugin-completion":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["cancel-plugin-completion"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["cancel-plugin-completion"]));
    case "load-plugin-state":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["load-plugin-state"])(payload).pipe(
        Effect.flatMap(client.plugins["load-plugin-state"]),
      );
    case "save-plugin-state":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["save-plugin-state"])(payload).pipe(
        Effect.flatMap(client.plugins["save-plugin-state"]),
      );
    case "call-plugin-backend":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["call-plugin-backend"])(payload).pipe(
        Effect.flatMap(client.plugins["call-plugin-backend"]),
      );
    case "cancel-plugin-backend-call":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["cancel-plugin-backend-call"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["cancel-plugin-backend-call"]));
    case "customization-rendered":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["customization-rendered"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["customization-rendered"]));
    case "customization-runtime-failed":
      return Schema.decodeUnknownEffect(cakeRpcPayloadSchemas["customization-runtime-failed"])(
        payload,
      ).pipe(Effect.flatMap(client.plugins["customization-runtime-failed"]));
    default:
      return Effect.die(new Error(`The RPC test harness cannot invoke ${type}`));
  }
}

const harness = {
  invokeNative: (input: JsonObject) => {
    const type = Schema.decodeUnknownSync(Schema.String)(input.type);
    const payload = { ...input };
    Reflect.deleteProperty(payload, "type");
    return run(withClient((client) => invokeSmokeCommand(client, type, payload)));
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
  agentAvailability: () =>
    collect(
      Stream.unwrap(
        Effect.map(CakeIpcClient, (client) => client.application.observeAgentAvailability()),
      ).pipe(Stream.take(1)),
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
