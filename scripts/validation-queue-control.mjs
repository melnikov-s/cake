import process from "node:process";
import console from "node:console";
import { validationQueueState, setValidationQueueCapacity } from "./validation-queue.mjs";

const usage = "Usage: pnpm validation:queue status | capacity <positive-integer>";
const [command = "status", value, ...extra] = process.argv.slice(2);
if (command === "--help" || command === "help") {
  console.log(usage);
  console.log("Three shared Cake validation slots by default. Reductions never stop running work.");
} else {
  if (
    extra.length ||
    (command === "status" && value !== undefined) ||
    (command !== "status" && command !== "capacity")
  )
    throw new Error(usage);
  if (command === "capacity" && !/^[1-9]\d*$/.test(value ?? ""))
    throw new Error("Capacity must be a positive integer.");
  console.log(
    JSON.stringify(
      command === "status" ? validationQueueState() : setValidationQueueCapacity(Number(value)),
    ),
  );
}
