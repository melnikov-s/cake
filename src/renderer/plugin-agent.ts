import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reaction } from "r-state-tree";
import { useStore } from "r-state-tree/react";
import type {
  PluginAgentOpenOptions,
  PluginAgentSnapshot,
  PluginCompletionRequest,
  PluginCompletionResult,
  PluginSessionActivity,
  SessionRef,
} from "../ipc/plugin-agent-contract";
import type { SessionSnapshot, UiPart } from "../ipc/session-contract";
import { RootStore } from "./stores/RootStore";
import { useCurrentPluginId } from "./plugin-runtime";
import { useRendererInfrastructure } from "./RendererInfrastructureContext";

function implicitSession(root: RootStore): SessionRef | undefined {
  const selection = root.appShellStore.selection;
  return selection.kind === "project-session"
    ? { kind: "cake.session-ref", id: JSON.stringify({ sessionId: selection.sessionId }) }
    : undefined;
}

export interface PluginAgentHandle {
  readonly ref?: SessionRef;
  readonly resolvedModel?: PluginAgentSnapshot["resolvedModel"];
  readonly status: "closed" | "opening" | "idle" | "running" | "error";
  readonly parts: readonly UiPart[];
  readonly usage?: SessionSnapshot["usage"];
  readonly error?: string;
  open(options: PluginAgentOpenOptions): Promise<void>;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
}

export function usePluginAgent(options: { abortOnUnmount?: boolean } = {}): PluginAgentHandle {
  const root = useStore(RootStore);
  const infrastructure = useRendererInfrastructure();
  const pluginId = useCurrentPluginId();
  const [snapshot, setSnapshot] = useState<PluginAgentSnapshot>();
  const [opening, setOpening] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const latest = useRef(snapshot);
  latest.current = snapshot;

  useEffect(
    () =>
      infrastructure.subscribe((event) => {
        if (
          event.type === "plugin-agent-event" &&
          event.pluginId === pluginId &&
          event.snapshot.handleId === latest.current?.handleId
        )
          setSnapshot(event.snapshot);
      }),
    [infrastructure, pluginId],
  );

  useEffect(
    () => () => {
      const current = latest.current;
      if (!current) return;
      if (options.abortOnUnmount && current.status === "running")
        void root.client.plugins
          .abortAgent(pluginId, current.handleId)
          .finally(() => root.client.plugins.detachAgent(pluginId, current.handleId));
      else void root.client.plugins.detachAgent(pluginId, current.handleId);
    },
    [options.abortOnUnmount, pluginId, root],
  );

  const open = useCallback(
    async (input: PluginAgentOpenOptions) => {
      const previous = latest.current;
      if (previous) await root.client.plugins.detachAgent(pluginId, previous.handleId);
      setOpening(true);
      setLocalError(undefined);
      setSnapshot(undefined);
      try {
        setSnapshot(await root.client.plugins.openAgent(pluginId, input, implicitSession(root)));
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        setOpening(false);
      }
    },
    [pluginId, root],
  );

  const deliver = useCallback(
    async (delivery: "prompt" | "steer" | "follow-up", text: string) => {
      const current = latest.current;
      if (!current) throw new Error("Open the plugin agent before prompting it");
      if (delivery === "prompt" && current.status !== "idle")
        throw new Error("A normal prompt requires an idle plugin agent");
      setLocalError(undefined);
      try {
        setSnapshot(
          await root.client.plugins.promptAgent(pluginId, current.handleId, delivery, text),
        );
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    [pluginId, root],
  );

  const abort = useCallback(async () => {
    const current = latest.current;
    if (!current) return;
    setSnapshot(await root.client.plugins.abortAgent(pluginId, current.handleId));
  }, [pluginId, root]);

  return useMemo(
    () => ({
      ref: snapshot?.ref,
      resolvedModel: snapshot?.resolvedModel,
      status: opening
        ? ("opening" as const)
        : localError
          ? ("error" as const)
          : (snapshot?.status ?? ("closed" as const)),
      parts: snapshot?.parts ?? [],
      usage: snapshot?.usage,
      error: localError ?? snapshot?.error,
      open,
      prompt: (text: string) => deliver("prompt", text),
      steer: (text: string) => deliver("steer", text),
      followUp: (text: string) => deliver("follow-up", text),
      abort,
    }),
    [abort, deliver, localError, open, opening, snapshot],
  );
}

function revision(parts: readonly UiPart[]) {
  let hash = 2166136261;
  for (const character of JSON.stringify(
    parts.map((part) => [
      part.id,
      part.kind,
      "entryId" in part ? part.entryId : undefined,
      part.kind === "text" ? part.status : undefined,
    ]),
  )) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

export function usePluginSessionActivity(): PluginSessionActivity {
  const root = useStore(RootStore);
  const selection = root.appShellStore.selection;
  if (selection.kind !== "project-session")
    throw new Error("usePluginSessionActivity() requires a selected project session");
  const current = (): PluginSessionActivity => {
    const model = root.sessionRegistry.findModel(selection.sessionId);
    const parts = model?.uiParts ?? [];
    const messages = parts.filter(
      (part): part is Extract<UiPart, { kind: "text" }> =>
        part.kind === "text" && Boolean(part.entryId),
    );
    return {
      streaming: model?.streaming ?? false,
      settledRevision: revision(parts),
      leafId: messages.at(-1)?.entryId,
      lastMessageId: messages.at(-1)?.entryId,
    };
  };
  const [value, setValue] = useState(current);
  useEffect(
    () =>
      reaction(current, (next) =>
        setValue((previous) => ({
          ...next,
          settledRevision: next.streaming ? previous.settledRevision : next.settledRevision,
        })),
      ),
    [root, selection.sessionId],
  );
  return value;
}

export interface PluginCompletionHandle {
  readonly status: "idle" | "running" | "error";
  readonly result?: PluginCompletionResult;
  readonly error?: string;
  run(request: PluginCompletionRequest): Promise<PluginCompletionResult>;
  abort(): Promise<void>;
}

export function usePluginCompletion(): PluginCompletionHandle {
  const root = useStore(RootStore);
  const pluginId = useCurrentPluginId();
  const active = useRef<string | undefined>(undefined);
  const [state, setState] = useState<{
    status: PluginCompletionHandle["status"];
    result?: PluginCompletionResult;
    error?: string;
  }>({ status: "idle" });
  const abort = useCallback(async () => {
    const requestId = active.current;
    if (!requestId) return;
    active.current = undefined;
    await root.client.plugins.cancelCompletion(pluginId, requestId);
    setState({ status: "idle" });
  }, [pluginId, root]);
  useEffect(
    () => () => {
      if (active.current) void root.client.plugins.cancelCompletion(pluginId, active.current);
    },
    [pluginId, root],
  );
  const run = useCallback(
    async (request: PluginCompletionRequest) => {
      if (active.current) await root.client.plugins.cancelCompletion(pluginId, active.current);
      const requestId = crypto.randomUUID();
      active.current = requestId;
      setState({ status: "running" });
      try {
        const result = await root.client.plugins.runCompletion(
          pluginId,
          requestId,
          request,
          implicitSession(root),
        );
        if (active.current === requestId) {
          active.current = undefined;
          setState({ status: "idle", result });
        }
        return result;
      } catch (error) {
        if (active.current === requestId) {
          active.current = undefined;
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    },
    [pluginId, root],
  );
  return useMemo(() => ({ ...state, run, abort }), [abort, run, state]);
}
