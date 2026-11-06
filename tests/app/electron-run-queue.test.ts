import { afterEach, beforeEach, expect, it } from "vitest";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import setup from "../../scripts/electron-playwright-setup";
import type { FullConfig } from "@playwright/test";
import { electronQueueState, setElectronQueueCapacity } from "../../scripts/electron-run-queue.mjs";

const clientPath = fileURLToPath(new URL("../fixtures/electron-queue-client.mjs", import.meta.url));
const jobPath = fileURLToPath(new URL("../fixtures/electron-queue-job.mjs", import.meta.url));
const queueModule = resolve("scripts/electron-run-queue.mjs");
type Event = {
  type: string;
  code?: number;
  position?: number;
  capacity?: number;
  running?: number;
  error?: string;
};
type Client = {
  process: ChildProcess;
  events: Event[];
  exit: Promise<number | null>;
  stderr: () => string;
};
let root: string;
let queuePath: string;
let clients: Client[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cake-queue-test-")));
  queuePath = join(root, "queue.sqlite");
  clients = [];
  setElectronQueueCapacity(1, queuePath);
});
afterEach(async () => {
  for (const client of clients) if (client.process.connected) client.process.send({ cancel: true });
  await Promise.all(clients.map((client) => client.exit));
  await rm(root, { recursive: true, force: true });
});

function start(
  name: string,
  options: { cwd?: string; mode?: string; timeoutMs?: number; command?: string } = {},
) {
  const child = fork(
    clientPath,
    [
      JSON.stringify({
        command: options.command ?? process.execPath,
        args: options.command ? [] : [jobPath, root, name, options.mode ?? "wait"],
        queuePath,
        cwd: options.cwd ?? root,
        timeoutMs: options.timeoutMs ?? 15_000,
      }),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const events: Event[] = [];
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("message", (event) => events.push(event as Event));
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code && !events.some((event) => event.type === "finished" || event.type === "failed"))
        events.push({ type: "unexpected-exit", error: stderr });
      resolveExit(code);
    });
  });
  const client = { process: child, events, exit, stderr: () => stderr };
  clients.push(client);
  return client;
}
async function event(client: Client, type: string) {
  await expect
    .poll(() => client.events.find((entry) => entry.type === type), { timeout: 10_000 })
    .toBeDefined();
  return client.events.find((entry) => entry.type === type)!;
}
async function started(name: string): Promise<{ pid: number; cwd: string }> {
  const path = join(root, `${name}.started`);
  try {
    await expect.poll(() => existsSync(path), { timeout: 10_000 }).toBe(true);
  } catch (error) {
    throw new Error(`${String(error)}\n${clients.map((client) => client.stderr()).join("\n")}`, {
      cause: error,
    });
  }
  return JSON.parse(await readFile(path, "utf8"));
}
function release(name: string, code = 0) {
  return writeFile(join(root, `${name}.release`), String(code));
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function rows(table: "requests" | "electron_groups" | "admissions") {
  const db = new DatabaseSync(queuePath);
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    db.close();
  }
}
async function empty() {
  await expect.poll(() => rows("requests"), { timeout: 10_000 }).toEqual([]);
  expect(rows("electron_groups")).toEqual([]);
  expect(rows("admissions")).toEqual([]);
}

it("uses one host path despite worktree/profile/home/temp environment differences", async () => {
  const paths = [];
  for (const name of ["worktree-a", "worktree-b"]) {
    const cwd = join(root, name);
    await mkdir(cwd);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { electronQueuePath } from ${JSON.stringify(queueModule)}; console.log(electronQueuePath());`,
      ],
      {
        cwd,
        env: { ...process.env, HOME: cwd, CAKE_HOME: cwd, TMPDIR: cwd },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    paths.push(result.stdout.trim());
  }
  expect(paths[0]).toBe(paths[1]);
  expect(paths[0]).toMatch(/^\/tmp\/cake-electron-runs-\d+\.sqlite$/);
});

it("serializes independent processes in different worktrees in FIFO order and releases on success", async () => {
  const a = join(root, "worktree-a");
  const b = join(root, "worktree-b");
  await Promise.all([mkdir(a), mkdir(b)]);
  const first = start("first", { cwd: a });
  expect((await started("first")).cwd).toBe(a);
  expect(await event(first, "running")).toMatchObject({ capacity: 1, running: 1, queued: 0 });
  const second = start("second", { cwd: b });
  expect((await event(second, "queued")).position).toBe(1);
  const third = start("third", { cwd: a });
  expect((await event(third, "queued")).position).toBe(2);
  expect(existsSync(join(root, "second.started"))).toBe(false);
  await release("first");
  expect(await first.exit).toBe(0);
  expect((await started("second")).cwd).toBe(b);
  expect(existsSync(join(root, "third.started"))).toBe(false);
  await release("second");
  expect(await second.exit).toBe(0);
  await started("third");
  await release("third");
  expect(await third.exit).toBe(0);
  await empty();
}, 20_000);

it("cancels a queued request without starting it or delaying the next ticket", async () => {
  const first = start("first");
  await started("first");
  const cancelled = start("cancelled");
  await event(cancelled, "queued");
  const next = start("next");
  await event(next, "queued");
  cancelled.process.send({ cancel: true });
  expect(await cancelled.exit).toBe(130);
  expect(existsSync(join(root, "cancelled.started"))).toBe(false);
  await release("first");
  expect(await first.exit).toBe(0);
  await started("next");
  await release("next");
  expect(await next.exit).toBe(0);
  await empty();
}, 20_000);

it("releases after job failure and executable launch failure", async () => {
  const failed = start("failed");
  await started("failed");
  await release("failed", 7);
  expect(await failed.exit).toBe(7);
  await empty();
  const missing = start("missing", { command: join(root, "not-an-executable") });
  expect(await missing.exit).toBe(1);
  await empty();
  const next = start("next");
  await started("next");
  await release("next");
  expect(await next.exit).toBe(0);
  await empty();
}, 20_000);

it("cleans up an aborted running job and a timed-out job before releasing admission", async () => {
  const aborted = start("aborted");
  const first = await started("aborted");
  aborted.process.send({ cancel: true });
  expect(await aborted.exit).toBe(130);
  expect(alive(first.pid)).toBe(false);
  await empty();
  const timedOut = start("timed-out", { timeoutMs: 1_500 });
  const second = await started("timed-out");
  expect(await timedOut.exit).toBe(124);
  expect(alive(second.pid)).toBe(false);
  await empty();
}, 20_000);

it("survives caller SIGKILL and cleans detached application groups before admitting the next run", async () => {
  const crashed = start("crashed", { mode: "detached" });
  const app = await started("crashed");
  const next = start("next");
  await event(next, "queued");
  crashed.process.kill("SIGKILL");
  await crashed.exit;
  await started("next");
  expect(alive(app.pid)).toBe(false);
  await release("next");
  expect(await next.exit).toBe(0);
  await empty();
}, 20_000);

it("recovers stale supervisor ownership after SIGKILL without overlapping its surviving job", async () => {
  const crashed = start("crashed", { mode: "detached" });
  const app = await started("crashed");
  const owner = Number(rows("requests")[0]!.owner);
  const next = start("next");
  await event(next, "queued");
  process.kill(owner, "SIGKILL");
  expect(await crashed.exit).toBe(1);
  await started("next");
  expect(alive(app.pid)).toBe(false);
  await release("next");
  expect(await next.exit, next.stderr()).toBe(0);
  await empty();
}, 20_000);

it("reclaims a crashed queued supervisor without ever launching its job", async () => {
  const first = start("first");
  await started("first");
  const crashed = start("crashed-queued");
  await event(crashed, "queued");
  const owner = rows("requests").find((row) => row.group_id === null)!;
  process.kill(Number(owner.owner), "SIGKILL");
  expect(await crashed.exit).toBe(1);
  const next = start("next");
  await event(next, "queued");
  await release("first");
  expect(await first.exit).toBe(0);
  await started("next");
  expect(existsSync(join(root, "crashed-queued.started"))).toBe(false);
  await release("next");
  expect(await next.exit).toBe(0);
  await empty();
}, 20_000);

it("serializes parallel detached launches within one admitted runner", async () => {
  const run = start("parallel", { mode: "parallel" });
  // Connection order, not process creation order, determines FIFO admission.
  await expect
    .poll(
      () =>
        ["parallel", "parallel-second"].filter((name) => existsSync(join(root, `${name}.started`))),
      { timeout: 10_000 },
    )
    .toHaveLength(1);
  const first = existsSync(join(root, "parallel.started")) ? "parallel" : "parallel-second";
  const second = first === "parallel" ? "parallel-second" : "parallel";
  const app = await started(first);
  await release(first);
  await started(second);
  expect(alive(app.pid)).toBe(false);
  await release(second);
  expect(await run.exit).toBe(0);
  await empty();
}, 20_000);

it("defaults to three slots and validates one shared host capacity across independent processes", () => {
  const path = join(root, "default.sqlite");
  expect(electronQueueState(path)).toEqual({ capacity: 3, running: 0, queued: 0 });
  expect(setElectronQueueCapacity(4, path)).toEqual({ capacity: 4, running: 0, queued: 0 });
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { electronQueueState } from ${JSON.stringify(queueModule)}; console.log(JSON.stringify(electronQueueState(${JSON.stringify(path)})));`,
    ],
    { cwd: root, env: { ...process.env, CAKE_HOME: root, TMPDIR: root }, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ capacity: 4, running: 0, queued: 0 });
  for (const invalid of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(() => setElectronQueueCapacity(invalid, path)).toThrow("positive integer");
  expect(electronQueueState(path).capacity).toBe(4);
});

it.each([3, 4])(
  "admits at most %i independent runs across worktrees and queues overflow FIFO",
  async (capacity) => {
    setElectronQueueCapacity(capacity, queuePath);
    const directories = [join(root, "worktree-a"), join(root, "worktree-b")];
    await Promise.all(directories.map((path) => mkdir(path)));
    const running = [];
    for (let i = 0; i < capacity; i++) {
      running.push(start(`active-${i}`, { cwd: directories[i % 2] }));
      await started(`active-${i}`);
    }
    const first = start("overflow-first");
    expect((await event(first, "queued")).position).toBe(1);
    const second = start("overflow-second");
    expect((await event(second, "queued")).position).toBe(2);
    expect(electronQueueState(queuePath)).toEqual({ capacity, running: capacity, queued: 2 });
    expect(existsSync(join(root, "overflow-first.started"))).toBe(false);
    await release("active-0");
    expect(await running[0]!.exit).toBe(0);
    await started("overflow-first");
    expect(existsSync(join(root, "overflow-second.started"))).toBe(false);
    expect(electronQueueState(queuePath)).toEqual({ capacity, running: capacity, queued: 1 });
    await release("overflow-first");
    expect(await first.exit, first.stderr()).toBe(0);
    await started("overflow-second");
    for (let i = 1; i < capacity; i++) await release(`active-${i}`);
    await release("overflow-second");
    expect(await Promise.all([...running.map((client) => client.exit), second.exit])).toEqual(
      Array(capacity + 1).fill(0),
    );
    await empty();
  },
  30_000,
);

it("atomically limits a burst of simultaneous independent callers to three slots", async () => {
  setElectronQueueCapacity(3, queuePath);
  const burst = Array.from({ length: 6 }, (_, i) => start(`burst-${i}`));
  await expect
    .poll(() => burst.filter((client) => client.events.at(-1)?.type === "running").length, {
      timeout: 10_000,
    })
    .toBe(3);
  await expect
    .poll(() => burst.filter((client) => client.events.at(-1)?.type === "queued").length, {
      timeout: 10_000,
    })
    .toBe(3);
  expect(electronQueueState(queuePath)).toEqual({ capacity: 3, running: 3, queued: 3 });
  const tickets = rows("requests")
    .map((row) => Number(row.id))
    .sort((a, b) => a - b);
  expect(
    rows("admissions")
      .map((row) => Number(row.request_id))
      .sort((a, b) => a - b),
  ).toEqual(tickets.slice(0, 3));
  for (let i = 0; i < burst.length; i++) await release(`burst-${i}`);
  expect(await Promise.all(burst.map((client) => client.exit))).toEqual(Array(6).fill(0));
  await empty();
}, 30_000);

it("applies live capacity changes without stopping active runs or admitting above a reduced limit", async () => {
  const first = start("first");
  const a = await started("first");
  const second = start("second");
  await event(second, "queued");
  const third = start("third");
  await event(third, "queued");
  setElectronQueueCapacity(3, queuePath);
  const b = await started("second");
  const c = await started("third");
  expect(setElectronQueueCapacity(1, queuePath)).toEqual({ capacity: 1, running: 3, queued: 0 });
  expect([a, b, c].every((job) => alive(job.pid))).toBe(true);
  const next = start("next");
  await event(next, "queued");
  await release("first");
  expect(await first.exit).toBe(0);
  await release("second");
  expect(await second.exit).toBe(0);
  expect(existsSync(join(root, "next.started"))).toBe(false);
  await release("third");
  expect(await third.exit).toBe(0);
  await started("next");
  await release("next");
  expect(await next.exit).toBe(0);
  await empty();
}, 30_000);

it("releases only a crashed run's slot while other admitted runs remain alive", async () => {
  setElectronQueueCapacity(3, queuePath);
  const crashed = start("crashed", { mode: "detached" });
  const a = await started("crashed");
  const second = start("second");
  const b = await started("second");
  const third = start("third");
  const c = await started("third");
  const next = start("next");
  await event(next, "queued");
  crashed.process.kill("SIGKILL");
  await crashed.exit;
  await started("next");
  expect(alive(a.pid)).toBe(false);
  expect([b, c].every((job) => alive(job.pid))).toBe(true);
  expect(electronQueueState(queuePath)).toEqual({ capacity: 3, running: 3, queued: 0 });
  await Promise.all([release("second"), release("third"), release("next")]);
  expect(await Promise.all([second.exit, third.exit, next.exit])).toEqual([0, 0, 0]);
  await empty();
}, 30_000);

it("routes maintained Playwright imports and package launch commands through the gate", () => {
  const paths = globSync([
    "tests/electron/**/*.ts",
    "tests/integration/**/*.ts",
    "scripts/**/*.{ts,mjs}",
  ]);
  const bypasses = paths.filter((path) => {
    if (path === "scripts/queued-electron.mjs") return false;
    return /import\s*\{[^}]*\b_electron\b[^}]*\}\s*from\s*["']@playwright\/test["']/.test(
      readFileSync(path, "utf8"),
    );
  });
  expect(bypasses).toEqual([]);
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  for (const name of ["dev", "dev:agent", "dev:manual", "start:direct"])
    expect(scripts[name]).toContain("scripts/electron-run-queue.mjs");
  for (const path of [
    "scripts/start-snapshot.mjs",
    "scripts/visual-capture/run.mjs",
    "playwright.config.ts",
    "playwright.performance.config.ts",
  ])
    expect(readFileSync(path, "utf8")).toContain("await queueElectronEntrypoint()");
});

it("rejects Playwright worker fan-out before tests start", () => {
  expect(() => setup({ workers: 2 } as FullConfig)).toThrow("--workers=1");
});
