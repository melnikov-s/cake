/* global process */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  electronQueueState,
  setElectronQueueCapacity,
  runElectronCommand,
} from "./electron-run-queue.mjs";

// Cake repository tooling only. Linked worktrees have different cwd/.git files
// but the same real Git common directory. Ignore HOME, TMPDIR and CAKE_HOME so
// isolated application profiles cannot accidentally create additional lanes.
export function validationQueuePath(cwd = process.cwd()) {
  if (process.platform === "win32")
    throw new Error("The validation queue currently requires macOS or Linux.");
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  });
  if (git.status !== 0) {
    // measure:session-switch builds a git-archive export with no .git metadata.
    // Only an already admitted ancestor may lend that export its identity.
    let inherited;
    try {
      inherited = JSON.parse(process.env.CAKE_VALIDATION_RUN ?? "null");
    } catch {
      /* no admission */
    }
    if (inherited?.path && isValidationRun(inherited.path)) return inherited.path;
    throw new Error("Validation requires a Cake Git checkout or an admitted ancestor.");
  }
  const identity = realpathSync(git.stdout.trim());
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const directory = join("/tmp", `cake-validation-${process.getuid()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${hash}.sqlite`);
}

export function validationQueueState(path = validationQueuePath()) {
  return electronQueueState(path, true);
}
export function setValidationQueueCapacity(capacity, path = validationQueuePath()) {
  return setElectronQueueCapacity(capacity, path, true);
}

// An inherited flag alone is insufficient: it must name this repository's
// admission and a live ancestor. Cross-repository nested commands still queue.
export function isValidationRun(path = validationQueuePath()) {
  let marker;
  try {
    marker = JSON.parse(process.env.CAKE_VALIDATION_RUN ?? "null");
  } catch {
    return false;
  }
  if (marker?.path !== path || !Number.isSafeInteger(marker.owner) || marker.owner <= 1)
    return false;
  let parent = process.ppid;
  while (parent > 1) {
    if (parent === marker.owner) {
      let db;
      try {
        db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
        return Boolean(
          db
            .prepare(`SELECT requests.id FROM requests JOIN admissions
          ON requests.id = request_id WHERE group_id = ?`)
            .get(marker.owner),
        );
      } catch {
        return false;
      } finally {
        db?.close();
      }
    }
    const result = spawnSync("ps", ["-p", String(parent), "-o", "ppid="], { encoding: "utf8" });
    if (result.status !== 0) return false;
    parent = Number(result.stdout.trim());
  }
  return false;
}

// Used inside an admitted workflow; children remain in the supervisor's group.
// No shell interpolation: arguments and inherited stdin/stdout/stderr are exact.
export function runInherited(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(signal ? 128 + constants.signals[signal] : (code ?? 1));
    });
  });
}

export async function runValidationCommand(command, args, options = {}) {
  const path = options.queuePath ?? validationQueuePath(options.cwd);
  const priority = options.priority ?? 1;
  if (![0, 1, 2].includes(priority)) throw new Error("Validation priority must be 0, 1 or 2.");
  if (isValidationRun(path)) return runInherited(command, args, options);
  return runElectronCommand(command, args, {
    ...options,
    queuePath: path,
    // Unlike automated Electron runs, compilation has no arbitrary deadline.
    timeoutMs: Infinity,
    validation: { priority, label: options.label ?? command },
  });
}
