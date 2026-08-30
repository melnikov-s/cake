import { EventEmitter } from "node:events";
import type { Event } from "electron";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, vi } from "vitest";
import { MainApplication, type MainApplicationOptions } from "../../../src/main/MainApplication";

class TestApplication extends EventEmitter {
  readonly quit = vi.fn(() => this.emit("before-quit", { preventDefault: vi.fn() }));
  private readonly ready: Promise<void>;

  constructor(ready: Promise<void> = Promise.resolve()) {
    super();
    this.ready = ready;
  }

  override on(eventName: "before-quit", listener: (event: Event) => void): this;
  override on(eventName: "window-all-closed", listener: () => void): this;
  override on(
    eventName: "before-quit" | "window-all-closed",
    listener: ((event: Event) => void) | (() => void),
  ): this {
    super.on(eventName, listener);
    this.emit(`listener:${eventName}`);
    return this;
  }

  whenReady() {
    return this.ready;
  }

  waitForListener(eventName: string) {
    if (this.listenerCount(eventName) > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.once(`listener:${eventName}`, resolve));
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
    application,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    platform: "linux",
    ...overrides,
  };
}

describe("MainApplication", () => {
  it.effect("starts after Electron is ready and stops on a quit request", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const start = vi.fn(async () => {});
      const stop = vi.fn();
      const fiber = yield* Effect.forkChild(MainApplication(options(application, { start, stop })));

      yield* Effect.promise(() => application.waitForListener("before-quit"));
      const event = application.requestQuit();
      yield* Fiber.join(fiber);

      expect(start).toHaveBeenCalledOnce();
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(application.listenerCount("before-quit")).toBe(0);
    }),
  );

  it.effect("delegates non-macOS window closure to Electron quit", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const fiber = yield* Effect.forkChild(MainApplication(options(application)));

      yield* Effect.promise(() => application.waitForListener("window-all-closed"));
      application.emit("window-all-closed");
      yield* Fiber.join(fiber);

      expect(application.quit).toHaveBeenCalledOnce();
    }),
  );

  it.effect("runs finalization when the application Scope is interrupted", () =>
    Effect.gen(function* () {
      const application = new TestApplication(new Promise(() => {}));
      const stop = vi.fn();
      const fiber = yield* Effect.forkChild(MainApplication(options(application, { stop })));

      yield* Effect.promise(() => application.waitForListener("before-quit"));
      yield* Fiber.interrupt(fiber);

      expect(stop).toHaveBeenCalledOnce();
      expect(application.listenerCount("before-quit")).toBe(0);
      expect(application.listenerCount("window-all-closed")).toBe(0);
    }),
  );

  it.effect("reports a failed bootstrap and still finalizes", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const failure = new Error("bootstrap failed");
      const stop = vi.fn();
      const reportDefect = vi.fn();
      const exit = yield* Effect.exit(
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
    }),
  );
});
