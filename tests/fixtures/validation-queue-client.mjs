import process from "node:process";
import { runValidationCommand } from "../../scripts/validation-queue.mjs";

const options = JSON.parse(process.argv[2]);
const controller = new AbortController();
process.on("message", () => controller.abort());
const code = await runValidationCommand(options.command ?? process.execPath, options.args, {
  ...options,
  signal: controller.signal,
  onEvent: (event) => {
    if (process.connected) process.send(event);
  },
});
if (process.connected) {
  process.send({ type: "finished", code });
  process.disconnect();
}
process.exitCode = code;
