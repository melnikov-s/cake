import { EventEmitter } from "node:events";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import { MainApplication, type MainApplicationOptions } from "../../../src/main/MainApplication";

class TestApplication extends EventEmitter {
  readonly quit = vi.fn(() => this.emit("before-quit", { preventDefault: vi.fn() }));
  private readonly ready: Promise<void>;

  constructor(ready: Promise<void> = Promise.resolve()) {
    super();
    this.ready = ready;
  }

  whenReady() {
    return this.ready;
  }

  requestQuit() {
    const event = { preventDefault: vi.fn() };
    this.emit("before-quit", event);
    return event;
  }
}

function options(
  application: TestApplication,
  overrides: Partial<MainApplicationOptions> = {},
): MainApplicationOptions {
  return {
    application: application as unknown as MainApplicationOptions["application"],
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    platform: "linux",
    ...overrides,
  };
}

describe("MainApplication", () => {
  it("starts after Electron is ready and stops on a quit request", async () => {
    const application = new TestApplication();
    const start = vi.fn(async () => {});
    const stop = vi.fn();
    const running = Effect.runPromise(MainApplication(options(application, { start, stop })));

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const event = application.requestQuit();
    await running;

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(application.listenerCount("before-quit")).toBe(0);
  });

  it("delegates non-macOS window closure to Electron quit", async () => {
    const application = new TestApplication();
    const running = Effect.runPromise(MainApplication(options(application)));

    await vi.waitFor(() => expect(application.listenerCount("window-all-closed")).toBe(1));
    application.emit("window-all-closed");
    await running;

    expect(application.quit).toHaveBeenCalledOnce();
  });

  it("runs finalization when the application Scope is interrupted", async () => {
    const application = new TestApplication(new Promise(() => {}));
    const stop = vi.fn();
    const fiber = Effect.runFork(MainApplication(options(application, { stop })));

    await vi.waitFor(() => expect(application.listenerCount("before-quit")).toBe(1));
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(stop).toHaveBeenCalledOnce();
    expect(application.listenerCount("before-quit")).toBe(0);
    expect(application.listenerCount("window-all-closed")).toBe(0);
  });

  it("reports a failed bootstrap and still finalizes", async () => {
    const application = new TestApplication();
    const failure = new Error("bootstrap failed");
    const stop = vi.fn();
    const reportDefect = vi.fn();
    const exit = await Effect.runPromiseExit(
      MainApplication(
        options(application, {
          start: vi.fn(async () => Promise.reject(failure)),
          stop,
          reportDefect,
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(reportDefect).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
