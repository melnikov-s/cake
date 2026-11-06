/* global AbortController */
import process from "node:process";
import { runElectronCommand } from "../../scripts/electron-run-queue.mjs";
const config = JSON.parse(process.argv[2]);
const controller = new AbortController();
process.on("message", () => controller.abort());
try {
  const code = await runElectronCommand(config.command, config.args, {
    ...config,
    signal: controller.signal,
    onEvent: (event) => process.send(event),
  });
  process.send({ type: "finished", code });
  process.disconnect();
  process.exitCode = code;
} catch (error) {
  process.send({ type: "failed", error: error.message });
  process.disconnect();
  process.exitCode = 1;
}
