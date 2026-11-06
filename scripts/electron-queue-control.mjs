import process from "node:process";
import console from "node:console";
import { electronQueueState, setElectronQueueCapacity } from "./electron-run-queue.mjs";

const [command = "status", value, ...extra] = process.argv.slice(2);
if (command === "--help" || command === "help") {
  console.log("Usage: pnpm electron:queue status | capacity <positive-integer>");
  console.log("Shared host capacity defaults to 3. Reducing it lets existing runs finish.");
} else {
  if (
    extra.length ||
    (command === "status" && value !== undefined) ||
    (command !== "status" && command !== "capacity")
  )
    throw new Error("Usage: pnpm electron:queue status | capacity <positive-integer>");
  if (command === "capacity" && !/^[1-9]\d*$/.test(value ?? ""))
    throw new Error("Electron queue capacity must be a positive integer.");
  const state =
    command === "status" ? electronQueueState() : setElectronQueueCapacity(Number(value));
  console.log(JSON.stringify(state));
}
