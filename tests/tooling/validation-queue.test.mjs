import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import {
  validationQueuePath,
  validationQueueState,
  setValidationQueueCapacity,
} from "../../scripts/validation-queue.mjs";
import { validationCommands, validationPriority } from "../../scripts/validation-run.mjs";

const clientPath = resolve("tests/fixtures/validation-queue-client.mjs");
const jobPath = resolve("tests/fixtures/validation-queue-job.mjs");
const runnerPath = resolve("scripts/validation-run.mjs");
const controlPath = resolve("scripts/validation-queue-control.mjs");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));

async function eventually(probe, message) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await delay(25);
  }
  assert.fail(message);
}
function fixture(t) {
  const root = realpathSync(mkdtempSync("/tmp/cake-validation-test-"));
  const path = join(root, "queue.sqlite");
  const clients = [];
  const registries = new Set();
  t.after(async () => {
    for (const client of clients)
      if (client.process.connected) client.process.send({ cancel: true });
    await Promise.all(clients.map((client) => client.exit));
    for (const registry of registries) {
      assert.equal(validationQueueState(registry).running, 0);
      await rm(registry, { force: true });
    }
    await rm(root, { recursive: true, force: true });
  });
  const start = (name, options = {}) => {
    const child = fork(
      clientPath,
      [
        JSON.stringify({
          args: [jobPath, root, name, options.mode ?? "wait", ...(options.extra ?? [])],
          queuePath: path,
          cwd: root,
          label: name,
          ...options,
        }),
      ],
      { cwd: options.cwd ?? root, stdio: ["pipe", "pipe", "pipe", "ipc"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const events = [];
    child.on("message", (event) => events.push(event));
    const exit = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    const client = { process: child, events, exit, stdout: () => stdout, stderr: () => stderr };
    clients.push(client);
    return client;
  };
  const started = (name) =>
    eventually(
      () => {
        const file = join(root, `${name}.started`);
        return existsSync(file) && JSON.parse(readFileSync(file, "utf8"));
      },
      `${name} never started\n${clients.map((c) => c.stderr()).join("\n")}`,
    );
  const event = (client, type) =>
    eventually(
      () => client.events.find((e) => e.type === type),
      `Missing ${type}: ${client.stderr()}`,
    );
  const release = (name, code = 0) => writeFileSync(join(root, `${name}.release`), String(code));
  const absent = (name) => assert.equal(existsSync(join(root, `${name}.started`)), false);
  const sql = (operation) => {
    const db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      return operation(db);
    } finally {
      db.close();
    }
  };
  return { root, path, clients, registries, start, started, event, release, absent, sql };
}
function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repo(root, name) {
  const cwd = join(root, name);
  const result = spawnSync("git", ["init", "-q", cwd], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  git(
    cwd,
    "-c",
    "user.name=Queue Test",
    "-c",
    "user.email=queue@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  return cwd;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function success(client, code = 0) {
  assert.deepEqual(await client.exit, { code, signal: null }, client.stderr());
}

// These tests intentionally use independent processes and real Git worktrees:
// the process/registry boundary IS the behavior under test. All children are fake.
test(
  "first use initializes once; independent worktrees share one lane",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const first = repo(f.root, "repo");
    const second = join(f.root, "worktree");
    git(first, "worktree", "add", "--quiet", "--detach", second, "HEAD");
    const path = validationQueuePath(first);
    f.registries.add(path);
    assert.equal(validationQueuePath(second), path);
    // Neither process initializes capacity first: concurrent first-use must be safe.
    const a = f.start("a", { cwd: first, queuePath: undefined });
    const b = f.start("b", { cwd: second, queuePath: undefined });
    await eventually(
      () =>
        a.events.some((e) => e.type === "running") || b.events.some((e) => e.type === "running"),
      "No admission",
    );
    const [running, queued, runningName, queuedName] = a.events.some((e) => e.type === "running")
      ? [a, b, "a", "b"]
      : [b, a, "b", "a"];
    await f.started(runningName);
    await f.event(queued, "queued");
    f.absent(queuedName);
    assert.deepEqual(validationQueueState(path), { capacity: 1, running: 1, queued: 1 });
    await eventually(
      () => /position 1 \(1\/1 running\); Ctrl-C cancels/.test(queued.stderr()),
      "Waiting caller never reported the updated queue position",
    );
    f.release(runningName);
    await success(running);
    assert.equal((await f.started(queuedName)).cwd, queuedName === "a" ? first : second);
    f.release(queuedName);
    await success(queued);
  },
);

test(
  "fast queued work overtakes full work without preempting the running child",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const a = f.start("a");
    const running = await f.started("a");
    const heavy = f.start("heavy", { priority: 2 });
    await f.event(heavy, "queued");
    const fast = f.start("fast", { priority: 0 });
    await f.event(fast, "queued");
    assert.equal(alive(running.pid), true);
    f.absent("fast");
    f.absent("heavy");
    f.release("a");
    await success(a);
    await f.started("fast");
    f.absent("heavy");
    f.release("fast");
    await success(fast);
    await f.started("heavy");
    f.release("heavy");
    await success(heavy);
  },
);

test(
  "aging lets an old expensive ticket beat newly arriving fast work",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const a = f.start("a");
    await f.started("a");
    const heavy = f.start("heavy", { priority: 2 });
    const ticket = await f.event(heavy, "queued");
    // Advance this ticket's arrival by 61s, rather than sleeping for a minute.
    f.sql((db) =>
      db
        .prepare("UPDATE validation_waiting SET sort_key = sort_key - 61000 WHERE request_id = ?")
        .run(ticket.id),
    );
    const fast = f.start("fast", { priority: 0 });
    await f.event(fast, "queued");
    f.release("a");
    await success(a);
    await f.started("heavy");
    f.absent("fast");
    f.release("heavy");
    await success(heavy);
    await f.started("fast");
    f.release("fast");
    await success(fast);
  },
);

test(
  "queued cancellation removes its ticket without launching; the next request advances",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const a = f.start("a");
    await f.started("a");
    const canceled = f.start("canceled");
    await f.event(canceled, "queued");
    canceled.process.send({ cancel: true });
    await success(canceled, 130);
    f.absent("canceled");
    const next = f.start("next");
    await f.event(next, "queued");
    f.release("a");
    await success(a);
    await f.started("next");
    f.release("next");
    await success(next);
    assert.deepEqual(validationQueueState(f.path), { capacity: 1, running: 0, queued: 0 });
  },
);

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(
    `${signal} reaches the running child and descendants before releasing capacity`,
    { timeout: 30_000 },
    async (t) => {
      const f = fixture(t);
      const a = f.start("a", { mode: "tree" });
      const parent = await f.started("a");
      const child = await f.started("a-descendant");
      const next = f.start("next");
      await f.event(next, "queued");
      a.process.kill(signal);
      await success(a, code);
      await f.started("next");
      assert.equal(alive(parent.pid), false);
      assert.equal(alive(child.pid), false);
      assert.equal(readFileSync(join(f.root, "a.signal"), "utf8"), signal);
      assert.equal(readFileSync(join(f.root, "a-descendant.signal"), "utf8"), signal);
      f.release("next");
      await success(next);
    },
  );
}

for (const target of ["caller", "supervisor"]) {
  test(
    `SIGKILL of ${target} recovers stale ownership without overlap`,
    { timeout: 30_000 },
    async (t) => {
      const f = fixture(t);
      const crashed = f.start("crashed", { mode: "tree" });
      const parent = await f.started("crashed");
      const child = await f.started("crashed-descendant");
      const next = f.start("next");
      await f.event(next, "queued");
      if (target === "caller") crashed.process.kill("SIGKILL");
      else
        process.kill(
          Number(
            f.sql((db) =>
              db
                .prepare("SELECT owner FROM requests JOIN admissions ON requests.id = request_id")
                .get(),
            ).owner,
          ),
          "SIGKILL",
        );
      await crashed.exit;
      await f.started("next");
      assert.equal(alive(parent.pid), false);
      assert.equal(alive(child.pid), false);
      f.release("next");
      await success(next);
      assert.deepEqual(validationQueueState(f.path), { capacity: 1, running: 0, queued: 0 });
    },
  );
}

for (const crash of [false, true]) {
  test(
    `nested detached Electron-tooling groups finish cleanup before the validation lane releases (crash=${crash})`,
    { timeout: 30_000 },
    async (t) => {
      const f = fixture(t);
      const outer = f.start("outer", {
        mode: "nested-electron",
        extra: [join(f.root, "electron.sqlite")],
      });
      const parent = await f.started("outer-electron");
      const child = await f.started("outer-electron-descendant");
      const next = f.start("next");
      await f.event(next, "queued");
      assert.ok(f.sql((db) => db.prepare("SELECT count(*) AS n FROM electron_groups").get()).n > 0);
      if (crash)
        process.kill(
          Number(
            f.sql((db) =>
              db
                .prepare("SELECT owner FROM requests JOIN admissions ON requests.id = request_id")
                .get(),
            ).owner,
          ),
          "SIGKILL",
        );
      else outer.process.kill("SIGTERM");
      await outer.exit;
      await f.started("next");
      assert.equal(alive(parent.pid), false);
      assert.equal(alive(child.pid), false);
      f.release("next");
      await success(next);
    },
  );
}

test(
  "stale queued owner is pruned and never blocks later tickets",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    validationQueueState(f.path);
    f.sql((db) => {
      const id = db
        .prepare("INSERT INTO requests(owner, identity) VALUES (?, ?)")
        .run(2147483647, "dead").lastInsertRowid;
      db.prepare("INSERT INTO validation_waiting VALUES (?, ?)").run(id, 0);
    });
    const next = f.start("next");
    await f.started("next");
    f.release("next");
    await success(next);
    assert.equal(validationQueueState(f.path).queued, 0);
  },
);

test(
  "capacity updates persist, admit two, and reductions let existing work finish",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const a = f.start("a");
    await f.started("a");
    const b = f.start("b");
    await f.event(b, "queued");
    const c = f.start("c");
    await f.event(c, "queued");
    assert.equal(setValidationQueueCapacity(2, f.path).capacity, 2);
    await f.started("b");
    f.absent("c");
    assert.equal(setValidationQueueCapacity(1, f.path).running, 2);
    f.release("a");
    await success(a);
    f.absent("c");
    assert.deepEqual(validationQueueState(f.path), { capacity: 1, running: 1, queued: 1 });
    f.release("b");
    await success(b);
    await f.started("c");
    f.release("c");
    await success(c);
    for (const invalid of [0, -1, 1.5, NaN, Infinity])
      assert.throws(() => setValidationQueueCapacity(invalid, f.path), /positive integer/);
  },
);

test(
  "arguments, stdin, stdout, stderr and child exit status are preserved",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const args = ["37", "spaces and 'quotes'", "--flag=x", "$HOME", "", "a;b"];
    const client = f.start("echo", { mode: "echo", extra: args });
    client.process.stdin.end("stdin payload\n");
    await success(client, 37);
    assert.deepEqual(JSON.parse(client.stdout()), { args, stdin: "stdin payload\n", cwd: f.root });
    assert.match(client.stderr(), /fake-stderr/);
    const signaled = f.start("signal", { mode: "child-signal" });
    await success(signaled, 143);
    const missing = f.start("missing", { command: "/definitely/missing/cake-validator", args: [] });
    await success(missing, 1);
    assert.match(missing.stderr(), /launch failed/);
  },
);

test(
  "nested admission reuses the running lane rather than waiting behind itself",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const outer = f.start("outer", { mode: "nested", extra: [f.path] });
    await f.started("outer-nested");
    assert.deepEqual(validationQueueState(f.path), { capacity: 1, running: 1, queued: 0 });
    f.release("outer-nested");
    await success(outer);
  },
);

test(
  "nested pnpm scripts use one admission; CLI capacity persists across processes",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const cwd = repo(f.root, "repo");
    const path = validationQueuePath(cwd);
    f.registries.add(path);
    const exported = join(f.root, "exported-without-git");
    mkdirSync(exported);
    writeFileSync(
      join(exported, "package.json"),
      JSON.stringify({
        scripts: {
          archived: `node ${runnerPath} -- pnpm --dir ${cwd} inner`,
        },
      }),
    );
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          outer: `node ${runnerPath} -- pnpm --dir ${exported} archived`,
          inner: `node ${runnerPath} -- node ${jobPath} ${f.root} inner`,
        },
      }),
    );
    const outer = f.start("unused", { command: "pnpm", args: ["outer"], cwd, queuePath: path });
    await f.started("inner");
    assert.deepEqual(validationQueueState(path), { capacity: 1, running: 1, queued: 0 });
    f.release("inner");
    await success(outer);
    for (const args of [["capacity", "3"], ["status"]]) {
      const result = spawnSync(process.execPath, [controlPath, ...args], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).capacity, 3);
    }
  },
);

test(
  "unrelated Git repositories are not serialized; forged inheritance cannot bypass admission",
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    const first = repo(f.root, "first");
    const second = repo(f.root, "second");
    const firstPath = validationQueuePath(first);
    const secondPath = validationQueuePath(second);
    f.registries.add(firstPath);
    f.registries.add(secondPath);
    assert.notEqual(firstPath, secondPath);
    const a = f.start("a", { cwd: first, queuePath: undefined });
    await f.started("a");
    const b = f.start("b", { cwd: second, queuePath: undefined });
    await f.started("b");
    const forged = f.start("forged", {
      cwd: first,
      queuePath: undefined,
      env: {
        ...process.env,
        CAKE_VALIDATION_RUN: JSON.stringify({ owner: 2147483647, path: firstPath }),
      },
    });
    await f.event(forged, "queued");
    f.absent("forged");
    f.release("a");
    await success(a);
    await f.started("forged");
    f.release("forged");
    await success(forged);
    f.release("b");
    await success(b);
  },
);

test("all heavy package entrypoints are gated; defaults bound workers and preserve native tsc", () => {
  for (const [name, entry] of Object.entries(validationCommands)) {
    assert.equal(manifest.scripts[name], `node scripts/validation-run.mjs ${name}`, name);
    assert.ok(entry.steps.length > 0);
  }
  const exempt = new Set([
    "start:server",
    "dev",
    "dev:agent",
    "dev:manual",
    "postinstall",
    "start",
    "start:direct",
    "electron:run",
    "electron:queue",
    "validation:queue",
    "validation:run",
    "build:start",
    "build:start:slim",
    "perf:accept",
  ]);
  assert.deepEqual(
    Object.keys(manifest.scripts).filter((name) => !exempt.has(name) && !validationCommands[name]),
    [],
  );
  assert.match(manifest.scripts["build:start:slim"], /pnpm build:slim && pnpm start/);
  assert.deepEqual(validationCommands.typecheck.steps, [["tsc", "--noEmit"]]);
  for (const config of ["vitest.config.ts", "vitest.integration.config.ts"])
    assert.match(readFileSync(config, "utf8"), /maxWorkers:\s*1\b/);
  assert.match(readFileSync("playwright.config.ts", "utf8"), /workers:\s*1\b/);
  assert.equal(validationPriority("test", []), 2);
  assert.equal(validationPriority("test", ["tests/app/example.test.ts"]), 0);
  assert.equal(validationPriority("test", ["navigation"]), 0);
  assert.equal(validationPriority("test", ["--reporter=default"]), 2);
  assert.equal(validationPriority("test", ["-t", "specific case"]), 0);
  assert.equal(validationPriority("test:integration", ["tests/integration/example.test.ts"]), 1);
  assert.equal(validationPriority("test:electron", ["tests/electron/example.spec.ts"]), 2);
});
