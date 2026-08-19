import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const pluginId = useCurrentPluginId();
  const [snapshot, setSnapshot] = useState<PluginAgentSnapshot>();
  const [opening, setOpening] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const latest = useRef(snapshot);
  latest.current = snapshot;

  useEffect(
    () =>
      root.client.subscribe((event) => {
        if (
          event.type === "plugin-agent-event" &&
          event.pluginId === pluginId &&
          event.snapshot.handleId === latest.current?.handleId
        )
          setSnapshot(event.snapshot);
      }),
    [pluginId, root],
  );

  useEffect(
    () => () => {
      const current = latest.current;
      if (!current) return;
      if (options.abortOnUnmount && current.status === "running")
        void root.client
          .abortPluginAgent(pluginId, current.handleId)
          .finally(() => root.client.detachPluginAgent(pluginId, current.handleId));
      else void root.client.detachPluginAgent(pluginId, current.handleId);
    },
    [options.abortOnUnmount, pluginId, root],
  );

  const open = useCallback(
    async (input: PluginAgentOpenOptions) => {
      const previous = latest.current;
      if (previous) await root.client.detachPluginAgent(pluginId, previous.handleId);
      setOpening(true);
      setLocalError(undefined);
      setSnapshot(undefined);
      try {
        setSnapshot(await root.client.openPluginAgent(pluginId, input, implicitSession(root)));
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
          await root.client.promptPluginAgent(pluginId, current.handleId, delivery, text),
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
    setSnapshot(await root.client.abortPluginAgent(pluginId, current.handleId));
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
  const model = root.sessionRegistry.findModel(selection.sessionId);
  const initial = (): PluginSessionActivity => {
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
  const [value, setValue] = useState(initial);
  useEffect(
    () =>
      root.client.subscribe((event) => {
        if (
          event.type === "session-snapshot-received" &&
          event.snapshot.workspacePath === selection.workspacePath &&
          event.snapshot.sessionId === selection.sessionId
        ) {
          const parts = event.snapshot.parts;
          const messages = parts.filter(
            (part): part is Extract<UiPart, { kind: "text" }> =>
              part.kind === "text" && Boolean(part.entryId),
          );
          setValue((current) => ({
            streaming: event.snapshot.streaming,
            settledRevision: event.snapshot.streaming ? current.settledRevision : revision(parts),
            leafId: messages.at(-1)?.entryId,
            lastMessageId: messages.at(-1)?.entryId,
          }));
        } else if (event.type === "streaming-changed" && event.sessionId === selection.sessionId)
          setValue((current) => ({ ...current, streaming: event.streaming }));
      }),
    [root, selection.sessionId, selection.workspacePath],
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
    await root.client.cancelPluginCompletion(pluginId, requestId);
    setState({ status: "idle" });
  }, [pluginId, root]);
  useEffect(
    () => () => {
      if (active.current) void root.client.cancelPluginCompletion(pluginId, active.current);
    },
    [pluginId, root],
  );
  const run = useCallback(
    async (request: PluginCompletionRequest) => {
      if (active.current) await root.client.cancelPluginCompletion(pluginId, active.current);
      const requestId = crypto.randomUUID();
      active.current = requestId;
      setState({ status: "running" });
      try {
        const result = await root.client.runPluginCompletion(
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
