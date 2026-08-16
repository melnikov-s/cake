import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCakePaths } from "../../../src/main/cake-paths";
import { PluginActivationService } from "../../../src/main/plugin-activation-service";
import type { PluginBuildService } from "../../../src/main/plugin-build-service";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const candidate = (revision: string, sourceRevision = revision) => ({ revision, sourceRevision, directory: `/builds/${revision}`, indexHtml: `/builds/${revision}/index.html`, diagnostics: [] });

describe("PluginActivationService", () => {
  it("requires a render handshake, retains rollback history, and rolls back atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-activation-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    const revisions = ["a".repeat(64), "b".repeat(64)];
    const builder = { buildCandidate: vi.fn(async () => candidate(revisions.shift()!)) } as unknown as PluginBuildService;
    const service = new PluginActivationService(paths, builder); await service.load();
    const first = await service.prepare();
    expect(service.startupRenderer()).toEqual({ kind: "factory" });
    await service.markHealthy(first.revision);
    expect(service.startupRenderer()).toMatchObject({ kind: "custom", revision: first.revision });
    const second = await service.prepare(); await service.markHealthy(second.revision);
    expect(service.snapshot().rollbackRevision).toBe(first.revision);
    expect(await service.rollback()).toBe(first.revision);
    expect(service.snapshot()).toMatchObject({ activeRevision: first.revision, recoveryRequired: false });
    expect((await readdir(join(paths.recovery, "history"))).some((name) => name.endsWith("-activated.json"))).toBe(true);
  });

  it("rejects a stale source base before starting another build", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-activation-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    const builder = { buildCandidate: vi.fn(async () => candidate("d".repeat(64))) } as unknown as PluginBuildService;
    const service = new PluginActivationService(paths, builder); await service.load();
    const first = await service.prepare(); await service.markHealthy(first.revision);
    await expect(service.prepare("e".repeat(64))).rejects.toThrow("Customization head changed");
    expect(builder.buildCandidate).toHaveBeenCalledTimes(1);
  });

  it("allows only one candidate build at a time", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-activation-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    let finish!: (value: ReturnType<typeof candidate>) => void;
    const builder = { buildCandidate: vi.fn(() => new Promise<ReturnType<typeof candidate>>((resolve) => { finish = resolve; })) } as unknown as PluginBuildService;
    const service = new PluginActivationService(paths, builder); await service.load();
    const first = service.prepare();
    await expect(service.prepare()).rejects.toThrow("already being built");
    finish(candidate("f".repeat(64)));
    await expect(first).resolves.toMatchObject({ revision: "f".repeat(64) });
  });

  it("selects factory recovery after an interrupted pending activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-activation-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    const builder = { buildCandidate: vi.fn(async () => candidate("c".repeat(64))) } as unknown as PluginBuildService;
    const first = new PluginActivationService(paths, builder); await first.load(); await first.prepare();
    const restarted = new PluginActivationService(paths, builder); await restarted.load();
    expect(restarted.startupRenderer()).toEqual({ kind: "factory" });
    expect(restarted.snapshot().diagnostics.at(-1)?.message).toContain("did not finish activation");
  });

  it("keeps build revisions out of user-facing diagnostic messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-activation-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    const revision = "f".repeat(64);
    const builder = { buildCandidate: vi.fn(async () => candidate(revision)) } as unknown as PluginBuildService;
    const service = new PluginActivationService(paths, builder); await service.load();

    await service.fail(revision, { phase: "render", message: "The custom interface did not finish loading." });

    expect(service.snapshot()).toMatchObject({
      failedRevision: revision,
      diagnostics: [{ phase: "render", message: "The custom interface did not finish loading." }]
    });
  });

  it("rebuilds an active customization when its bundled Cake renderer is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-activation-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    const sourceRevision = "a".repeat(64);
    const oldBuild = "b".repeat(64);
    const newBuild = "c".repeat(64);
    const initialBuilder = { buildCandidate: vi.fn(async () => candidate(oldBuild, sourceRevision)), isBuildCurrent: vi.fn(async () => true) } as unknown as PluginBuildService;
    const initial = new PluginActivationService(paths, initialBuilder); await initial.load();
    const first = await initial.prepare(); await initial.markHealthy(first.revision);

    const currentBuilder = { buildCandidate: vi.fn(async () => candidate(newBuild, sourceRevision)), isBuildCurrent: vi.fn(async () => false) } as unknown as PluginBuildService;
    const restarted = new PluginActivationService(paths, currentBuilder); await restarted.load();

    expect(currentBuilder.buildCandidate).toHaveBeenCalledOnce();
    expect(restarted.snapshot()).toMatchObject({ sourceRevision, pendingRevision: newBuild, recoveryRequired: true });
    expect(restarted.startupRenderer()).toEqual({ kind: "custom", revision: newBuild, path: join(paths.recovery, "builds", newBuild, "index.html") });
    await restarted.markHealthy(newBuild);
    expect(restarted.snapshot()).toMatchObject({ activeRevision: newBuild, lastKnownGoodRevision: newBuild, recoveryRequired: false });
    expect(restarted.snapshot().rollbackRevision).toBeUndefined();
  });
});
