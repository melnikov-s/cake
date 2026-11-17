/* global process */
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export function identity(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function liveMembers(pid, error) {
  const result = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (result.status !== 0) throw error;
  return result.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && state && !state.startsWith("Z");
  });
}

export function groupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // Darwin may report EPERM for an already disappearing group. Only a
    // successful membership probe proving no live members makes that benign.
    if (error.code === "EPERM") return liveMembers(pid, error);
    throw error;
  }
}

function signalGroup(pid, expectedIdentity, signal) {
  // The shim/bootstrap normally stays group leader until cleanup. If its PID
  // has been reused, never signal that new process's group. An absent leader
  // can still have surviving descendants in the original group.
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  if (!expectedIdentity || (result.status === 0 && result.stdout.trim() !== expectedIdentity))
    throw new Error(`Refusing to signal process group ${pid}: leader identity changed or unknown.`);
  if (result.status !== 0 && !(result.status === 1 && !result.stdout.trim()))
    throw new Error(`Cannot verify process group ${pid} before ${signal}.`, {
      cause: result.error,
    });
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    if (error.code === "EPERM" && !liveMembers(pid, error)) return;
    throw error;
  }
}

export async function cleanupGroup(pid, expectedIdentity, signal = "SIGTERM", graceMs = 250) {
  if (groupAlive(pid)) {
    signalGroup(pid, expectedIdentity, signal);
    await delay(graceMs);
    if (groupAlive(pid)) signalGroup(pid, expectedIdentity, "SIGKILL");
  }
  while (groupAlive(pid)) await delay(50);
}
