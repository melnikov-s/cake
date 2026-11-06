/* global process, console, setTimeout */
import { fork, spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const modulePath = fileURLToPath(import.meta.url);
const marker = "CAKE_ELECTRON_RUN_PARENT";

// Deliberately independent of cwd, CAKE_HOME, HOME and TMPDIR. Worktrees and
// isolated test profiles must compete for the same desktop user's host resource.
export function electronQueuePath() {
  if (process.platform === "win32")
    throw new Error("The Electron run queue currently requires macOS or Linux.");
  return join("/tmp", `cake-electron-runs-${process.getuid()}.sqlite`);
}

function identity(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function ownerAlive(row) {
  try {
    process.kill(row.owner, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
  }
  const current = identity(row.owner);
  // An unsuccessful process probe is not evidence that a live owner is stale.
  return !current || current === row.identity;
}

function groupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") {
      // Darwin can report EPERM while a killed group is disappearing. Check
      // membership instead of crashing cleanup or assuming an app is alive.
      const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
      if (result.status !== 0) throw error;
      return result.stdout.split("\n").some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === pid && state && !state.startsWith("Z");
      });
    }
    throw error;
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function cleanupGroup(pid) {
  if (groupAlive(pid)) {
    signalGroup(pid, "SIGTERM");
    await delay(250);
    if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
  }
  while (groupAlive(pid)) await delay(50);
}

function database(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5_000 });
  db.exec(`CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner INTEGER NOT NULL,
    identity TEXT NOT NULL,
    group_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS electron_groups (
    request_id INTEGER NOT NULL,
    pid INTEGER PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS admissions (
    request_id INTEGER PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS queue_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    capacity INTEGER NOT NULL CHECK (capacity > 0)
  );
  INSERT OR IGNORE INTO queue_control(id, capacity) VALUES (1, 3)`);
  return db;
}

function pruneStaleRequests(db) {
  for (const row of db.prepare("SELECT * FROM requests ORDER BY id").all()) {
    const groups = db.prepare("SELECT pid FROM electron_groups WHERE request_id = ?").all(row.id);
    // Keep a crashed owner's slot until every recorded group has exited.
    if (
      !ownerAlive(row) &&
      !groupAlive(row.group_id) &&
      groups.every((group) => !groupAlive(group.pid))
    ) {
      db.prepare("DELETE FROM electron_groups WHERE request_id = ?").run(row.id);
      db.prepare("DELETE FROM requests WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM admissions WHERE request_id = ?").run(row.id);
    }
  }
}

function queueState(db) {
  const capacity = Number(
    db.prepare("SELECT capacity FROM queue_control WHERE id = 1").get().capacity,
  );
  const running = Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM requests JOIN admissions ON requests.id = admissions.request_id",
      )
      .get().n,
  );
  const queued = Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM requests WHERE id NOT IN (SELECT request_id FROM admissions)",
      )
      .get().n,
  );
  return { capacity, running, queued };
}

export function electronQueueState(queuePath = electronQueuePath()) {
  const db = database(queuePath);
  try {
    pruneStaleRequests(db);
    return queueState(db);
  } finally {
    db.close();
  }
}

// This is host queue control, not a per-process environment override. Every
// waiting supervisor observes the same limit, including live increases/decreases.
export function setElectronQueueCapacity(capacity, queuePath = electronQueuePath()) {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new Error("Electron queue capacity must be a positive integer.");
  const db = database(queuePath);
  try {
    db.prepare("UPDATE queue_control SET capacity = ? WHERE id = 1").run(capacity);
    pruneStaleRequests(db);
    return queueState(db);
  } finally {
    db.close();
  }
}

// Nested harnesses and Playwright workers belong to the same admitted workflow.
// Verify ancestry, not just an inherited environment flag. Every detached
// Electron launch still passes through the serial executable handshake.
export function isElectronRun() {
  const owner = Number(process.env[marker]);
  if (!Number.isSafeInteger(owner) || owner <= 1 || !process.env.CAKE_ELECTRON_QUEUE_SOCKET)
    return false;
  let parent = process.ppid;
  while (parent > 1) {
    if (parent === owner) return true;
    const result = spawnSync("ps", ["-p", String(parent), "-o", "ppid="], { encoding: "utf8" });
    if (result.status !== 0) return false;
    parent = Number(result.stdout.trim());
  }
  return false;
}

export async function queueElectronEntrypoint(options = {}) {
  if (isElectronRun()) return;
  const code = await runElectronCommand(process.execPath, process.argv.slice(1), options);
  process.exit(code);
}

/**
 * Run one complete validation workflow. The supervisor survives caller death.
 * Interactive apps (dev, start) pass `timeoutMs: Infinity` so they are never
 * killed by the validation deadline.
 */
export function runElectronCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  if (timeoutMs !== Infinity && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
    throw new Error("Electron run timeout must be a positive integer in milliseconds or Infinity.");
  const queuePath = options.queuePath ?? electronQueuePath();
  return new Promise((resolve, reject) => {
    const supervisor = fork(modulePath, ["supervise"], {
      execArgv: [],
      detached: true,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: process.env,
    });
    const abort = () => {
      if (supervisor.connected) supervisor.send({ type: "cancel" });
    };
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    let result;
    supervisor.on("message", (message) => {
      if (message.type === "result") result = message.code;
      options.onEvent?.(message);
    });
    supervisor.once("error", reject);
    supervisor.once("exit", (code) => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
      options.signal?.removeEventListener("abort", abort);
      if (result === undefined)
        reject(new Error(`Electron supervisor exited unexpectedly (${code}).`));
      else resolve(result);
    });
    supervisor.send({
      type: "run",
      command,
      args,
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      path: queuePath,
      // IPC is JSON: Infinity would arrive as null, so send null explicitly.
      timeoutMs: timeoutMs === Infinity ? null : timeoutMs,
    });
    if (options.signal?.aborted) abort();
  });
}

async function supervise() {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  process.on("disconnect", cancel);
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const request = await new Promise((resolve) => {
    process.on("message", (message) => {
      if (message.type === "cancel") cancel();
      if (message.type === "run") resolve(message);
    });
  });
  const db = database(request.path);
  const ownerIdentity = identity(process.pid);
  if (!ownerIdentity) throw new Error("Cannot identify Electron supervisor process.");
  const id = Number(
    db
      .prepare("INSERT INTO requests(owner, identity) VALUES (?, ?)")
      .run(process.pid, ownerIdentity).lastInsertRowid,
  );
  const notify = (message) => {
    if (process.connected) process.send(message);
  };
  let job;
  let server;
  const sockets = new Set();
  const registrations = new Set();
  let launchTail = Promise.resolve();
  const socketPath = join("/tmp", `cake-er-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
  let code = 1;
  let previousFeedback;
  let admittedState;
  let nextStaleProbe = 0;
  try {
    while (!cancelled) {
      // Process probes launch ps; recovery need not repeat on every admission tick.
      if (Date.now() >= nextStaleProbe) {
        pruneStaleRequests(db);
        nextStaleProbe = Date.now() + 1_000;
      }
      // Claim a slot atomically, in ticket order. Never hold the SQLite write
      // lock during process probes.
      db.exec("BEGIN IMMEDIATE");
      let position;
      let state;
      let admitted = false;
      try {
        state = queueState(db);
        const head = db
          .prepare(
            "SELECT id FROM requests WHERE id NOT IN (SELECT request_id FROM admissions) ORDER BY id LIMIT 1",
          )
          .get();
        if (state.running < state.capacity && head?.id === id) {
          db.prepare("INSERT INTO admissions(request_id) VALUES (?)").run(id);
          admitted = true;
          admittedState = { ...state, running: state.running + 1, queued: state.queued - 1 };
        }
        position = Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM requests WHERE id <= ? AND id NOT IN (SELECT request_id FROM admissions)",
            )
            .get(id).n,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (admitted) break;
      const feedback = `${position}:${state.running}:${state.capacity}`;
      if (feedback !== previousFeedback) {
        console.error(
          `[cake:electron] queued #${id}, position ${position} (${state.running}/${state.capacity} running); Ctrl-C cancels`,
        );
        notify({ type: "queued", id, position, ...state });
        previousFeedback = feedback;
      }
      await delay(100);
    }
    if (cancelled) {
      code = 130;
      return;
    }
    console.error(
      `[cake:electron] running #${id} (${admittedState.running}/${admittedState.capacity}): ${request.command} ${request.args.join(" ")}`,
    );
    notify({ type: "running", id, ...admittedState });
    // Playwright detaches Electron into another process group. Its executable
    // shim registers that group BEFORE launching Electron, so it cannot escape
    // run cleanup even when the runner is SIGKILLed.
    server = createServer((socket) => {
      sockets.add(socket);
      let input = "";
      let registered = false;
      socket.on("data", (chunk) => {
        if (registered) return;
        input += chunk;
        if (!input.includes("\n")) return;
        registered = true;
        let message;
        try {
          message = JSON.parse(input.slice(0, input.indexOf("\n")));
        } catch {
          socket.destroy();
          return;
        }
        if (!Number.isSafeInteger(message.pid) || message.pid <= 1) {
          socket.destroy();
          return;
        }
        // Serialize actual launches too, including Promise.all inside one test.
        const previous = launchTail;
        if (registrations.size)
          console.error(`[cake:electron] queued application launch within #${id}`);
        const closed = new Promise((resolve) => socket.once("close", resolve));
        const registration = (async () => {
          await previous;
          if (socket.destroyed) return;
          db.prepare("INSERT INTO electron_groups(request_id, pid) VALUES (?, ?)").run(
            id,
            message.pid,
          );
          console.error(`[cake:electron] starting application within #${id}`);
          socket.write("start\n");
          await closed;
          await cleanupGroup(message.pid);
          db.prepare("DELETE FROM electron_groups WHERE pid = ?").run(message.pid);
        })();
        launchTail = registration;
        registrations.add(registration);
        registration.finally(() => registrations.delete(registration));
      });
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    request.env = { ...request.env, CAKE_ELECTRON_QUEUE_SOCKET: socketPath };
    // Bootstrap waits for 'start'. Persist ownership BEFORE it can launch any
    // application, closing the spawn/register crash window.
    job = fork(modulePath, ["job"], {
      execArgv: [],
      detached: true,
      cwd: request.cwd,
      env: request.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    let done;
    let failure;
    job.on("error", (error) => {
      failure = error;
    });
    job.on("exit", (exitCode) => {
      done ??= exitCode ?? 1;
    });
    job.on("message", (message) => {
      if (message.type === "done") done = message.code;
    });
    db.prepare("UPDATE requests SET group_id = ? WHERE id = ?").run(job.pid, id);
    job.send({ ...request, type: "start" });
    const deadline = request.timeoutMs === null ? Infinity : Date.now() + request.timeoutMs;
    while (done === undefined && !failure && !cancelled && Date.now() < deadline) await delay(50);
    if (failure) throw failure;
    code = cancelled ? 130 : done === undefined ? 124 : done;
    if (code === 124) console.error(`[cake:electron] timed out #${id}`);
  } finally {
    // Close the private registration channel first; live shims clean up their
    // own groups on EOF. Never signal processes found by app name or a port.
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
    await Promise.all(registrations);
    const groups = db.prepare("SELECT pid FROM electron_groups WHERE request_id = ?").all(id);
    while (groups.some((group) => groupAlive(group.pid))) await delay(50);
    db.prepare("DELETE FROM electron_groups WHERE request_id = ?").run(id);
    if (job?.pid) {
      // Only the freshly spawned, registered process group is signalled.
      // Bootstrap stays alive until cleanup, preventing group-id reuse here.
      await cleanupGroup(job.pid);
    }
    db.prepare("DELETE FROM requests WHERE id = ?").run(id);
    db.prepare("DELETE FROM admissions WHERE request_id = ?").run(id);
    db.close();
    console.error(`[cake:electron] released #${id}`);
    notify({ type: "result", code });
    if (process.connected) process.disconnect();
  }
}

async function bootstrap() {
  // Stay group leader until the supervisor has cleaned up every descendant.
  // If the supervisor crashes, IPC EOF triggers our own group cleanup.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.on("disconnect", () => {
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), 250);
  });
  const request = await new Promise((resolve) => process.once("message", resolve));
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: { ...request.env, [marker]: String(process.pid) },
    stdio: "inherit",
  });
  const report = (code) => {
    if (process.connected) process.send({ type: "done", code });
  };
  child.once("error", (error) => {
    console.error(`[cake:electron] launch failed: ${error.message}`);
    report(1);
  });
  child.once("exit", (code, signal) => report(signal ? 1 : (code ?? 1)));
}

if (process.argv[1] === modulePath) {
  const mode = process.argv[2];
  if (mode === "supervise") await supervise();
  else if (mode === "job") await bootstrap();
  else {
    let argv = process.argv.slice(2);
    const noTimeout = argv[0] === "--no-timeout";
    if (noTimeout) argv = argv.slice(1);
    const [command, ...args] = argv;
    if (!command)
      throw new Error(
        "Usage: node scripts/electron-run-queue.mjs [--no-timeout] <command> [args...]",
      );
    process.exitCode = await runElectronCommand(
      command,
      args,
      noTimeout ? { timeoutMs: Infinity } : {},
    );
  }
}
