import { Deferred, Effect, Stream } from "effect";
import type { CakeSessionRuntimesAdapter } from "../../../src/services/pi/CakeSessionRuntimes";
import type { CakeSessionRuntimeOptions } from "../../../src/services/pi/runtime/cake-session-runtime";
import type {
  ChatConfiguration,
  ConversationSnapshot,
  PiSessionSummary,
} from "../../../src/ipc/session-contract";
import type { PiModel } from "../../../src/services/pi/model-data";
import { fakeRuntime, snapshot } from "../../app/helpers/piRuntimeFixture";

export const browserTestModel: typeof PiModel.Type = {
  provider: "test",
  providerName: "Test",
  id: "controlled",
  name: "Controlled model",
  reasoning: false,
  supportedThinkingLevels: ["off"],
  fastMode: false,
  input: ["text"],
  authenticated: true,
  available: true,
  authTypes: ["api_key"],
};
const existingId = "00000000-0000-4000-8000-000000000001";

/** Controlled external Pi adapter; endpoint, admission, leases, catalogs and reducers stay real. */
export function browserBackendAdapter() {
  const summaries = new Map<string, PiSessionSummary>();
  const entries = new Map<string, ConversationSnapshot>();
  const pending = new Map<string, { finish(): void }>();
  const stats = { turns: 0, aborts: 0, acquisitions: 0 };
  const configurations: ChatConfiguration[] = [];
  let configurationGate:
    | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
    | undefined;
  const pauseNextConfiguration = () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    configurationGate = { entered, release };
    return {
      entered: () => Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("10 seconds"))),
      release: () => Effect.runSync(Deferred.succeed(release, undefined)),
    };
  };
  const initial = (id: string): ConversationSnapshot => ({
    ...snapshot,
    sessionId: id,
    sessionFile: `/sessions/${id}.jsonl`,
    model: { provider: "test", id: "controlled", name: "Controlled model" },
    models: [{ ...browserTestModel, availableThinkingLevels: ["off"] }],
  });
  const remember = (id: string) => {
    summaries.set(id, {
      id,
      title: id === existingId ? "Existing chat" : "Browser chat",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      resolved: false,
    });
    if (!entries.has(id)) entries.set(id, initial(id));
  };
  remember(existingId);
  const adapter: CakeSessionRuntimesAdapter = {
    sessionIds: () => Stream.fromIterable(summaries.keys()),
    catalog: () => Stream.fromIterable(summaries.values()),
    catalogEntry: (_query, id) => Effect.succeed(summaries.get(id)),
    inspect: (target) =>
      Effect.succeed(
        entries.has(target.sessionId)
          ? {
              workspacePath: "/project",
              sessionId: target.sessionId,
              sessionFile: `/sessions/${target.sessionId}.jsonl`,
              parts: entries.get(target.sessionId)?.parts ?? [],
            }
          : undefined,
      ),
    changelog: () => Effect.succeed("Test"),
    createRuntime: (options: CakeSessionRuntimeOptions) =>
      Effect.sync(() => {
        stats.acquisitions++;
        const id = options.sessionId ?? existingId;
        remember(id);
        const get = () => {
          const entry = entries.get(id);
          if (!entry) throw new Error("Missing fixture session");
          return entry;
        };
        const publish = (entry: ConversationSnapshot) => {
          entries.set(id, entry);
          options.onEvent({ type: "snapshot", snapshot: entry });
        };
        return {
          ...fakeRuntime(options, () => undefined),
          sessionId: id,
          sessionFile: `/sessions/${id}.jsonl`,
          get streaming() {
            return get().streaming;
          },
          snapshot: async () => get(),
          applyConfiguration: async (configuration) => {
            const gate = configurationGate;
            configurationGate = undefined;
            if (gate) {
              Effect.runSync(Deferred.succeed(gate.entered, undefined));
              await Effect.runPromise(Deferred.await(gate.release));
            }
            configurations.push(configuration);
            publish({
              ...get(),
              model: {
                provider: configuration.provider,
                id: configuration.modelId,
                name: browserTestModel.name,
              },
              thinkingLevel: configuration.thinkingLevel,
              fastMode: configuration.fastMode,
            });
          },
          prompt: async (text: string) => {
            stats.turns++;
            const turn = stats.turns;
            const gate = Deferred.makeUnsafe<void>();
            pending.set(id, {
              finish: () => {
                Effect.runSync(Deferred.succeed(gate, undefined));
              },
            });
            publish({
              ...get(),
              streaming: true,
              parts: [
                ...get().parts,
                { id: `user-${turn}`, kind: "text", role: "user", status: "complete", text },
                {
                  id: `tool-${turn}`,
                  kind: "tool",
                  name: "read",
                  input: '{"path":"README.md"}',
                  output: "Controlled tool output",
                  state: "running",
                },
                {
                  id: `answer-${turn}`,
                  kind: "text",
                  role: "assistant",
                  status: "streaming",
                  text: "Streaming controlled answer",
                },
              ],
            });
            await Effect.runPromise(Deferred.await(gate));
            pending.delete(id);
            publish({
              ...get(),
              streaming: false,
              parts: get().parts.map((part) =>
                part.id === `answer-${turn}`
                  ? {
                      id: part.id,
                      kind: "text",
                      role: "assistant",
                      status: "complete",
                      text: `Completed answer ${turn}`,
                    }
                  : part.id === `tool-${turn}` && part.kind === "tool"
                    ? { ...part, state: "success" }
                    : part,
              ),
            });
          },
          abort: async () => {
            stats.aborts++;
            pending.get(id)?.finish();
          },
        };
      }),
  };
  return {
    adapter,
    stats,
    configurations,
    pauseNextConfiguration,
    existingId,
    finish: (id: string) => pending.get(id)?.finish(),
  };
}
