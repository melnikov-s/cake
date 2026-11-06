#!/usr/bin/env node
/* global process, console, setTimeout, setInterval, clearInterval */
import { spawn } from "node:child_process";
import { connect } from "node:net";

const socketPath = process.env.CAKE_ELECTRON_QUEUE_SOCKET;
const executable = process.env.CAKE_QUEUED_ELECTRON_EXECUTABLE;
if (!socketPath || !executable)
  throw new Error("Electron must launch inside the shared run queue.");

// Playwright creates this process as a detached group leader. Vite and snapshot
// launches already belong to the supervised job group and do not use this shim.
if (process.pid === 1) throw new Error("Invalid Electron launch process.");
const socket = connect(socketPath);
let child;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  process.kill(-process.pid, "SIGTERM");
  setTimeout(() => process.kill(-process.pid, "SIGKILL"), 250);
};
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
socket.on("error", (error) => {
  console.error(`[cake:electron] queue connection failed: ${error.message}`);
  stop();
});
socket.on("close", stop);
const parent = process.ppid;
const watchdog = setInterval(() => {
  if (process.ppid !== parent) stop();
}, 100);
socket.once("connect", () => socket.write(`${JSON.stringify({ pid: process.pid })}\n`));
socket.once("data", () => {
  if (stopping) return;
  child = spawn(executable, process.argv.slice(2), { stdio: "inherit", env: process.env });
  child.once("error", (error) => {
    console.error(`[cake:electron] launch failed: ${error.message}`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    clearInterval(watchdog);
    process.exit(signal ? 1 : (code ?? 1));
  });
});
