import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportMainFailure } from "../../../src/main/report-main-failure";

const fixture = vi.hoisted(() => ({
  events: [] as string[],
  primary: true,
  userData: "/isolated/default-profile",
  host: { kind: "local" } as { kind: "local" } | { kind: "remote"; url: string },
  layer: undefined as Layer.Layer<never, unknown> | undefined,
  program: undefined as Effect.Effect<void, unknown> | undefined,
  exited: (code: number) => {
    throw new Error(`Unexpected exit: ${code}`);
  },
}));

const application = vi.hoisted(() => ({
  setName: vi.fn(),
  setPath: vi.fn((_name: string, path: string) => {
    fixture.userData = path;
    fixture.events.push("userData");
  }),
  getPath: vi.fn(() => fixture.userData),
  requestSingleInstanceLock: vi.fn(() => {
    fixture.events.push("lock");
    return fixture.primary;
  }),
  whenReady: vi.fn(async () => {
    fixture.events.push("ready");
  }),
  exit: vi.fn((code: number) => {
    fixture.events.push(`exit:${code}`);
    fixture.exited(code);
  }),
}));

vi.mock("electron", () => ({ app: application, nativeTheme: {} }));
// Smoke-hook implementations are outside startup sequencing; do not load their domain graph.
vi.mock("../../../src/domain/artifacts/messageBoards", () => ({}));
vi.mock("../../../src/domain/artifacts/cake-artifact-operations", () => ({
  createCakeArtifactOperations: vi.fn(),
}));
vi.mock("../../../src/services/pi/runtime/cake-operation-registry", () => ({
  CakeOperationRegistry: vi.fn(),
}));
vi.mock("../../../src/services/widgets/inline-widget-service", () => ({
  compileInlineWidget: vi.fn(),
}));
vi.mock("../../../src/services/electron/inline-widget-protocol", () => ({
  handleInlineWidgetScheme: vi.fn(),
}));
vi.mock("../../../src/services/electron/extension-companion-protocol", () => ({
  handleExtensionCompanionScheme: vi.fn(),
}));
vi.mock("../../../src/main/stdio-errors", () => ({ installStdioErrorHandlers: vi.fn() }));
vi.mock("../../../src/main/process-errors", () => ({ installProcessErrorHandlers: vi.fn() }));
vi.mock("../../../src/main/report-main-failure", () => ({ reportMainFailure: vi.fn() }));
vi.mock("../../../src/config/CakePaths", () => ({ resolveCakePaths: vi.fn(() => ({})) }));
vi.mock("../../../src/services/pi/PiPaths", () => ({
  piAgentDirectory: vi.fn(() => "/isolated/pi"),
}));
vi.mock("../../../src/services/electron/rich-content-protocols", () => ({
  registerRichContentSchemes: vi.fn(),
}));
vi.mock("../../../src/services/electron/DesktopHostLive", () => ({
  loadDesktopHost: vi.fn(() => fixture.host),
  installDesktopSocketOrigin: vi.fn(() => fixture.events.push("socket-origin")),
}));
vi.mock("../../../src/main/MainLive", () => ({
  makeMainLive: vi.fn(() => {
    fixture.events.push("local-graph");
    return fixture.layer;
  }),
}));
vi.mock("../../../src/main/RemoteMainLive", () => ({
  makeRemoteMainLive: vi.fn(() => {
    fixture.events.push("remote-graph");
    return fixture.layer;
  }),
}));
vi.mock("../../../src/main/MainApplication", () => ({
  MainApplication: vi.fn(() => fixture.program),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("CAKE_ELECTRON_SMOKE", "0");
  vi.stubEnv("CAKE_ELECTRON_USER_DATA", "");
  vi.stubEnv("ELECTRON_RENDERER_URL", "");
  fixture.events = [];
  fixture.primary = true;
  fixture.userData = "/isolated/default-profile";
  fixture.host = { kind: "local" };
  fixture.layer = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => fixture.events.push("backend-acquire")),
      () => Effect.sync(() => fixture.events.push("backend-release")),
    ),
  );
  fixture.program = Effect.sync(() => {
    fixture.events.push("application");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function launch() {
  const exit = new Promise<number>((resolve) => {
    fixture.exited = resolve;
  });
  await import("../../../src/main/main");
  return exit;
}

describe("production Electron startup", () => {
  it("primary startup acquires lock before backend and readiness, then disposes runtime", async () => {
    expect(await launch()).toBe(0);
    expect(fixture.events).toEqual([
      "lock",
      "local-graph",
      "backend-acquire",
      "ready",
      "socket-origin",
      "application",
      "backend-release",
      "exit:0",
    ]);
    expect(application.requestSingleInstanceLock).toHaveBeenCalledOnce();
  });

  it.each(["local", "remote"] as const)(
    "%s secondary denial does not initialize graph or delete upload staging",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "cake-startup-lock-"));
      try {
        const staging = join(root, "attachment-uploads");
        await mkdir(staging);
        const upload = join(staging, "active-upload");
        await writeFile(upload, "primary upload in progress");
        vi.stubEnv("CAKE_ELECTRON_USER_DATA", root);
        fixture.primary = false;
        fixture.host =
          mode === "local" ? { kind: "local" } : { kind: "remote", url: "wss://fixture" };
        // A destructive resource-acquisition fake: denial must not run even its first step.
        fixture.layer = Layer.effectDiscard(Effect.promise(() => rm(staging, { recursive: true })));
        application.whenReady.mockImplementationOnce(() => new Promise(() => {}));
        expect(await launch()).toBe(0);
        expect(fixture.events).toEqual(["userData", "lock", "exit:0"]);
        expect(application.whenReady).not.toHaveBeenCalled();
        expect(await readFile(upload, "utf8")).toBe("primary upload in progress");
      } finally {
        application.whenReady.mockReset().mockImplementation(async () => {
          fixture.events.push("ready");
        });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("configured userData is selected before the lock", async () => {
    vi.stubEnv("CAKE_ELECTRON_USER_DATA", "/isolated/configured-profile");
    application.requestSingleInstanceLock.mockImplementationOnce(() => {
      expect(fixture.userData).toBe("/isolated/configured-profile");
      fixture.events.push("lock");
      return true;
    });
    expect(await launch()).toBe(0);
    expect(fixture.events.slice(0, 3)).toEqual(["userData", "lock", "local-graph"]);
  });

  it("remote startup retains native-only graph selection and socket initialization", async () => {
    fixture.host = { kind: "remote", url: "wss://fixture" };
    fixture.layer = Layer.effectDiscard(Effect.sync(() => fixture.events.push("native-acquire")));
    expect(await launch()).toBe(0);
    expect(fixture.events.slice(0, 2)).toEqual(["lock", "remote-graph"]);
    expect(fixture.events).not.toContain("local-graph");
    expect(fixture.events).not.toContain("backend-acquire");
    expect(fixture.events.indexOf("socket-origin")).toBeLessThan(
      fixture.events.indexOf("application"),
    );
  });

  it.each(["acquisition", "application"] as const)(
    "runtime %s failure disposes before exit",
    async (stage) => {
      if (stage === "acquisition") {
        fixture.layer = Layer.effectDiscard(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => fixture.events.push("backend-acquire")),
              () => Effect.sync(() => fixture.events.push("backend-release")),
            );
            return yield* Effect.fail("backend startup failed");
          }),
        );
      } else fixture.program = Effect.fail("application startup failed");
      expect(await launch()).toBe(1);
      expect(fixture.events.slice(-2)).toEqual(["backend-release", "exit:1"]);
      expect(reportMainFailure).toHaveBeenCalledOnce();
      if (stage === "acquisition") expect(application.whenReady).not.toHaveBeenCalled();
    },
  );

  it("reports runtime finalization failure and exits unsuccessfully", async () => {
    fixture.layer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => fixture.events.push("backend-acquire")),
        () => Effect.die("runtime finalization failed"),
      ),
    );
    expect(await launch()).toBe(1);
    expect(reportMainFailure).toHaveBeenCalledOnce();
    expect(reportMainFailure).toHaveBeenCalledWith(
      expect.stringContaining("runtime finalization failed"),
    );
  });
});
