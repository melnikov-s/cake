import { Exit, Effect, Layer, Scope, Stream } from "effect";
import type { CakeRuntimeOptions } from "./runtime/cake-runtime";
import { forkWorkspaceSession } from "./runtime/session-discovery";
import type { PluginAgentDriver } from "../plugins/plugin-agent-host";
import { PiPluginAgents, PiPluginAgentsError } from "./PiPluginAgents";
import { PiSessions, type PiSessionAcquireOptions, type PiSessionHandle } from "./PiSessions";

const MAX_LIVE_PRIVATE_PLUGIN_AGENTS = 32;

interface Lease {
  readonly handle: PiSessionHandle;
  readonly scope: Scope.Closeable;
  readonly privateSession: boolean;
  leases: number;
}

export interface PiPluginAgentsLiveOptions {
  readonly projectSessionDirectory: string;
  readonly privateSessionDirectory: string;
  readonly runtimeOptions: (
    workingDirectory: string,
    input: {
      readonly sessionId: string;
      readonly sessionFile?: string;
      readonly sessionDirectory: string;
      readonly newSession: boolean;
      readonly instructions?: string;
      readonly visibility: "private" | "project";
    },
  ) =>
    | Omit<CakeRuntimeOptions, "onEvent">
    | {
        readonly runtime: Omit<CakeRuntimeOptions, "onEvent">;
        readonly onRelease?: () => Promise<void>;
      };
  readonly runEffect: <A, E>(
    effect: Effect.Effect<A, E, PiSessions>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

const pluginAgentError = (operation: string, cause: unknown) =>
  new PiPluginAgentsError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makePiPluginAgentsLive = (options: PiPluginAgentsLiveOptions) => {
  const drivers = new Map<string, PluginAgentDriver>();
  const closeDrivers = new Set<() => Promise<void>>();

  const makeDriver = (workingDirectory: string): PluginAgentDriver => {
    const leases = new Map<string, Lease>();
    let privateReservations = 0;

    const acquire = async (input: {
      readonly sessionId: string;
      readonly sessionFile?: string;
      readonly sessionDirectory: string;
      readonly newSession: boolean;
      readonly instructions?: string;
      readonly visibility: "private" | "project";
    }) => {
      const existing = leases.get(input.sessionId);
      if (existing) {
        existing.leases += 1;
        return existing;
      }
      const privateSession = input.visibility === "private";
      if (
        privateSession &&
        [...leases.values()].filter((lease) => lease.privateSession).length + privateReservations >=
          MAX_LIVE_PRIVATE_PLUGIN_AGENTS
      )
        throw new Error(
          `This workspace already has ${MAX_LIVE_PRIVATE_PLUGIN_AGENTS} live private plugin agents`,
        );
      if (privateSession) privateReservations += 1;
      const scope = await options.runEffect(Scope.make());
      try {
        const configured = options.runtimeOptions(workingDirectory, input);
        const runtime = "runtime" in configured ? configured.runtime : configured;
        const profile = { _tag: "PluginAgentSession" as const, visibility: input.visibility };
        const acquireOptions: PiSessionAcquireOptions =
          "runtime" in configured && configured.onRelease
            ? { profile, runtime, onRelease: Effect.promise(configured.onRelease) }
            : { profile, runtime };
        const handle = await options.runEffect(
          Effect.flatMap(PiSessions, (sessions) => sessions.acquire(acquireOptions)).pipe(
            Effect.provideService(Scope.Scope, scope),
          ),
        );
        const lease: Lease = {
          handle,
          scope,
          privateSession,
          leases: 1,
        };
        leases.set(input.sessionId, lease);
        return lease;
      } catch (error) {
        await options.runEffect(Scope.close(scope, Exit.void));
        throw error;
      } finally {
        if (privateSession) privateReservations -= 1;
      }
    };

    const acquireCurrent = async (sessionId: string) => {
      const scope = await options.runEffect(Scope.make());
      try {
        const handle = await options.runEffect(
          Effect.flatMap(PiSessions, (sessions) =>
            sessions.acquireCurrent({
              workingDirectory,
              sessionId,
              sessionDirectory: options.projectSessionDirectory,
            }),
          ).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        const lease: Lease = { handle, scope, privateSession: false, leases: 1 };
        leases.set(sessionId, lease);
        return lease;
      } catch (error) {
        await options.runEffect(Scope.close(scope, Exit.void));
        throw error;
      }
    };

    const requireLease = (sessionId: string) => {
      const lease = leases.get(sessionId);
      if (!lease) throw new Error("That session is not open in this plugin agent driver");
      return lease;
    };

    const close = async () => {
      const current = [...leases.values()];
      leases.clear();
      await Promise.all(
        current.map((lease) => options.runEffect(Scope.close(lease.scope, Exit.void))),
      );
    };
    closeDrivers.add(close);

    return {
      openAgent: async ({ target, instructions }) => {
        let sessionId: string;
        let sessionFile: string | undefined;
        let sessionDirectory = options.projectSessionDirectory;
        let visibility: "private" | "project";
        let newSession = false;
        if (target.kind === "new") {
          sessionId = crypto.randomUUID();
          visibility = target.visibility;
          sessionDirectory =
            visibility === "private"
              ? options.privateSessionDirectory
              : options.projectSessionDirectory;
          newSession = true;
        } else if (target.kind === "attach") {
          const existing = leases.get(target.sessionId);
          if (existing) {
            existing.leases += 1;
            return options.runEffect(existing.handle.snapshot());
          }
          sessionId = target.sessionId;
          visibility = "project";
          try {
            const current = await acquireCurrent(sessionId);
            return options.runEffect(current.handle.snapshot());
          } catch {
            // A closed Project Session is acquired below from its durable Pi transcript.
          }
        } else {
          const source = requireLease(target.sessionId);
          const sourceSnapshot = await options.runEffect(source.handle.snapshot());
          const entryId =
            target.entryId ??
            [...sourceSnapshot.parts]
              .reverse()
              .flatMap((part) => ("entryId" in part && part.entryId ? [part.entryId] : []))[0];
          if (!entryId) throw new Error("The source session has no branch leaf to fork");
          if (!sourceSnapshot.sessionFile) throw new Error("The source session is not persisted");
          visibility = target.visibility;
          sessionDirectory =
            visibility === "private"
              ? options.privateSessionDirectory
              : options.projectSessionDirectory;
          const forked = forkWorkspaceSession(
            sourceSnapshot.sessionFile,
            workingDirectory,
            sessionDirectory,
          );
          sessionId = forked.sessionId;
          sessionFile = forked.sessionFile;
          const forkLease = await acquire({
            sessionId,
            sessionFile,
            sessionDirectory,
            newSession: false,
            instructions,
            visibility,
          });
          await options.runEffect(forkLease.handle.navigate(entryId));
          return options.runEffect(forkLease.handle.snapshot());
        }
        const lease = await acquire({
          sessionId,
          sessionFile,
          sessionDirectory,
          newSession,
          instructions,
          visibility,
        });
        return options.runEffect(lease.handle.snapshot());
      },
      configureAgent: async (sessionId, provider, modelId, thinkingLevel) => {
        const handle = requireLease(sessionId).handle;
        await options.runEffect(handle.setModel(provider, modelId));
        await options.runEffect(handle.setThinkingLevel(thinkingLevel));
        return options.runEffect(handle.snapshot());
      },
      subscribeAgent: (sessionId, listener) => {
        const controller = new AbortController();
        const handle = requireLease(sessionId).handle;
        void options
          .runEffect(
            handle.updates.pipe(
              Stream.runForEach((update) => {
                if (update._tag === "Snapshot")
                  return Effect.sync(() =>
                    listener({ type: "snapshot", snapshot: update.snapshot }),
                  );
                const event = update.event;
                if (
                  event.type === "turn-accepted" ||
                  event.type === "turn-settled" ||
                  event.type === "snapshot-updated"
                )
                  return Effect.void;
                return Effect.sync(() => listener(event));
              }),
            ),
            controller.signal,
          )
          .catch((error) => {
            if (!controller.signal.aborted)
              console.error("[cake.plugins] Plugin agent observation failed", error);
          });
        return () => controller.abort();
      },
      agentSnapshot: (sessionId) => options.runEffect(requireLease(sessionId).handle.snapshot()),
      agentPrompt: async (sessionId, text, delivery) => {
        const handle = requireLease(sessionId).handle;
        if (delivery === "prompt") await options.runEffect(handle.prompt(text));
        else if (delivery === "steer") await options.runEffect(handle.steer(text));
        else await options.runEffect(handle.followUp(text));
        return options.runEffect(handle.snapshot());
      },
      agentAbort: async (sessionId) => {
        const handle = requireLease(sessionId).handle;
        await options.runEffect(handle.abort());
        return options.runEffect(handle.snapshot());
      },
      releaseAgent: (sessionId) => {
        const lease = leases.get(sessionId);
        if (!lease) return;
        lease.leases -= 1;
        if (lease.leases > 0) return;
        leases.delete(sessionId);
        void options.runEffect(Scope.close(lease.scope, Exit.void));
      },
    };
  };

  const service = PiPluginAgents.of({
    driver: (workingDirectory) => {
      const existing = drivers.get(workingDirectory);
      if (existing) return existing;
      const driver = makeDriver(workingDirectory);
      drivers.set(workingDirectory, driver);
      return driver;
    },
    closeAll: Effect.fn("PiPluginAgents.closeAll")(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await Promise.all([...closeDrivers].map((close) => close()));
          closeDrivers.clear();
          drivers.clear();
        },
        catch: (cause) => pluginAgentError("closeAll", cause),
      });
    }),
  });

  const layer = Layer.effect(
    PiPluginAgents,
    Effect.acquireRelease(Effect.succeed(service), () => service.closeAll().pipe(Effect.orDie)),
  );
  return { layer, controller: { driver: service.driver } } as const;
};
