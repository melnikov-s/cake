import { createStore, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { StagedSessionCommandStore } from "../../../../src/renderer/stores/StagedSessionCommandStore";
import { mountWithClient } from "../mount-with-client";

type Commands = Awaited<ReturnType<Client["workspaces"]["loadStagedSlashCommands"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function skill(name: string): Commands[number] {
  return {
    name: `skill:${name}`,
    description: `${name} skill`,
    source: "skill",
    sourceInfo: {
      path: `/skills/${name}/SKILL.md`,
      source: name,
      scope: "project",
      origin: "top-level",
    },
  };
}

function mountCommands(loadStagedSlashCommands: Client["workspaces"]["loadStagedSlashCommands"]) {
  return mountWithClient(createStore(StagedSessionCommandStore), {
    workspaces: { loadStagedSlashCommands },
  } as unknown as Client);
}

describe("StagedSessionCommandStore", () => {
  it("commits only the latest workspace discovery", async () => {
    const first = deferred<Commands>();
    const second = deferred<Commands>();
    const load = vi
      .fn<Client["workspaces"]["loadStagedSlashCommands"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { root, subject: store } = mountCommands(load);

    const firstLoad = store.load("/first");
    const secondLoad = store.load("/second");
    second.resolve([skill("latest")]);
    await secondLoad;
    first.resolve([skill("stale")]);
    await firstLoad;

    expect(store.resourceCommands.map((command) => command.name)).toEqual(["skill:latest"]);
    expect(load.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    root[Symbol.dispose]();
  });

  it("clears commands from the previous workspace while the replacement loads", async () => {
    const replacement = deferred<Commands>();
    const load = vi
      .fn<Client["workspaces"]["loadStagedSlashCommands"]>()
      .mockResolvedValueOnce([skill("previous")])
      .mockReturnValueOnce(replacement.promise);
    const { root, subject: store } = mountCommands(load);
    await store.load("/previous");

    const replacing = store.load("/replacement");
    expect(store.resourceCommands).toEqual([]);
    replacement.resolve([skill("replacement")]);
    await replacing;
    expect(store.resourceCommands.map((command) => command.name)).toEqual(["skill:replacement"]);
    root[Symbol.dispose]();
  });

  it("invalidates an in-flight discovery when the session materializes", async () => {
    const pending = deferred<Commands>();
    const { root, subject: store } = mountCommands(vi.fn(() => pending.promise));

    const load = store.load("/project");
    store.invalidate();
    pending.resolve([skill("too-late")]);
    await load;

    expect(store.commands.map((command) => command.name)).toEqual(["model", "name"]);
    expect(store.resourceCommands).toEqual([]);
    root[Symbol.dispose]();
  });

  it("does not advertise runtime-only commands before materialization", () => {
    const { root, subject: store } = mountCommands(vi.fn(async () => []));
    expect(store.commands.map((command) => command.name)).toEqual(["model", "name"]);
    expect(toSnapshot(store).state).not.toHaveProperty("resourceCommands");
    root[Symbol.dispose]();
  });
});
