import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginPersistenceRepository } from "../../../../src/services/plugins/plugin-persistence-repository";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("PluginPersistenceRepository", () => {
  it("separates global and session namespaces and rejects stale writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-state-"));
    roots.push(root);
    const repository = new PluginPersistenceRepository(root, () => "a".repeat(64));
    const global = await repository.write(
      "example.calendar",
      "view",
      { kind: "global" },
      { mode: "month" },
      0,
    );
    const session = await repository.write(
      "example.calendar",
      "view",
      { kind: "session", sessionId: "session/one" },
      { mode: "week" },
      0,
    );
    expect((await repository.read("example.calendar", "view", { kind: "global" }))?.value).toEqual({
      mode: "month",
    });
    expect(
      (
        await repository.read("example.calendar", "view", {
          kind: "session",
          sessionId: "session/one",
        })
      )?.value,
    ).toEqual({ mode: "week" });
    await expect(
      repository.write("example.calendar", "view", { kind: "global" }, {}, 0),
    ).rejects.toThrow("changed concurrently");
    expect(global.version).toBe(1);
    expect(session.sourceRevision).toBe("a".repeat(64));
  });

  it("serializes version validation and writes for the same record", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-state-"));
    roots.push(root);
    const repository = new PluginPersistenceRepository(root, () => "a".repeat(64));
    const scope = { kind: "global" as const };

    const results = await Promise.allSettled([
      repository.write("example.calendar", "view", scope, { mode: "month" }, 0),
      repository.write("example.calendar", "view", scope, { mode: "week" }, 0),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await repository.read("example.calendar", "view", scope))?.version).toBe(1);
  });
});
