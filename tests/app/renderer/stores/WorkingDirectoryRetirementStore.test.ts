import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { WorkingDirectoryRetirementStore } from "../../../../src/renderer/stores/WorkingDirectoryRetirementStore";
import { mountWithClient } from "../mount-with-client";

function mountRetirement(commands: Partial<Client["terminals"]> = {}) {
  const onRetired = vi.fn();
  const terminals: Client["terminals"] = {
    open: async () => {
      throw new Error("Unexpected terminal open");
    },
    write: async () => undefined,
    resize: async () => undefined,
    workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
    close: async () => undefined,
    closeWorkingDirectory: async () => undefined,
    ...commands,
  };
  const mounted = mountWithClient(createStore(WorkingDirectoryRetirementStore, { onRetired }), {
    terminals,
  } as unknown as Client);
  return { ...mounted, onRetired };
}

describe("WorkingDirectoryRetirementStore", () => {
  it("immediately retires directories whose terminals are waiting at shell prompts", async () => {
    const workingDirectoryStatus = vi.fn(async () => ({ runningProgramCount: 0 }));
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const {
      root,
      subject: store,
      onRetired,
    } = mountRetirement({
      workingDirectoryStatus,
      closeWorkingDirectory,
    });
    try {
      await expect(store.prepare(["/one", "/one", "/two"])).resolves.toBe(true);
      expect(workingDirectoryStatus).toHaveBeenCalledTimes(2);
      expect(closeWorkingDirectory).toHaveBeenCalledTimes(2);
      expect(onRetired).toHaveBeenCalledWith(["/one", "/two"]);
      expect(store.confirmationRequest).toBeUndefined();
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("presents the total running-program count and retires after confirmation", async () => {
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const {
      root,
      subject: store,
      onRetired,
    } = mountRetirement({
      workingDirectoryStatus: async (directory) => ({
        runningProgramCount: directory === "/one" ? 1 : 2,
      }),
      closeWorkingDirectory,
    });
    try {
      const result = store.prepare(["/one", "/two"]);
      await vi.waitFor(() => expect(store.confirmationRequest).toEqual({ runningProgramCount: 3 }));
      await store.confirm();
      await expect(result).resolves.toBe(true);
      expect(closeWorkingDirectory).toHaveBeenCalledTimes(2);
      expect(onRetired).toHaveBeenCalledWith(["/one", "/two"]);
      expect(store.confirmationRequest).toBeUndefined();
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("cancels without closing resources", async () => {
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const {
      root,
      subject: store,
      onRetired,
    } = mountRetirement({
      workingDirectoryStatus: async () => ({ runningProgramCount: 1 }),
      closeWorkingDirectory,
    });
    try {
      const result = store.prepare(["/one"]);
      await vi.waitFor(() => expect(store.confirmationRequest).toBeDefined());
      store.cancel();
      await expect(result).resolves.toBe(false);
      expect(closeWorkingDirectory).not.toHaveBeenCalled();
      expect(onRetired).not.toHaveBeenCalled();
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("rejects repeated and concurrent requests while inspecting or confirming", async () => {
    let finishStatus!: (status: { runningProgramCount: number }) => void;
    const { root, subject: store } = mountRetirement({
      workingDirectoryStatus: () =>
        new Promise((resolve) => {
          finishStatus = resolve;
        }),
    });
    try {
      const result = store.prepare(["/one"]);
      await expect(store.prepare(["/one"])).resolves.toBe(false);
      await expect(store.prepare(["/two"])).resolves.toBe(false);
      finishStatus({ runningProgramCount: 1 });
      await vi.waitFor(() => expect(store.confirmationRequest).toBeDefined());
      await expect(store.prepare(["/one"])).resolves.toBe(false);
      store.cancel();
      await expect(result).resolves.toBe(false);
    } finally {
      root[Symbol.dispose]();
    }
  });

  it("resolves a pending confirmation as cancelled when disposed", async () => {
    const { root, subject: store } = mountRetirement({
      workingDirectoryStatus: async () => ({ runningProgramCount: 1 }),
    });
    const result = store.prepare(["/one"]);
    await vi.waitFor(() => expect(store.confirmationRequest).toBeDefined());
    root[Symbol.dispose]();
    await expect(result).resolves.toBe(false);
  });

  it("cancels an in-flight inspection when disposed", async () => {
    const { root, subject: store } = mountRetirement({
      workingDirectoryStatus: (_directory, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    });
    const result = store.prepare(["/one"]);
    root[Symbol.dispose]();
    await expect(result).resolves.toBe(false);
  });

  it("does not treat failed inspection as an idle terminal", async () => {
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const {
      root,
      subject: store,
      onRetired,
    } = mountRetirement({
      workingDirectoryStatus: async () => {
        throw new Error("Inspection failed");
      },
      closeWorkingDirectory,
    });
    try {
      await expect(store.prepare(["/one"])).rejects.toThrow("Inspection failed");
      expect(closeWorkingDirectory).not.toHaveBeenCalled();
      expect(onRetired).not.toHaveBeenCalled();
    } finally {
      root[Symbol.dispose]();
    }
  });
});
