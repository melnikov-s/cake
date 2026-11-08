import { bootstrapTiming } from "../services/diagnostics/bootstrap-timing";
import { installStdioErrorHandlers } from "./stdio-errors";

installStdioErrorHandlers(process.stdout, process.stderr);
bootstrapTiming.mark("entryMs");
console.info("Cake bootstrap", { pid: process.pid, ...bootstrapTiming.snapshot() });
// Keep this dynamic: static imports would hide the entire backend/SDK import cost
// before the first executable entry receipt. The original entry owns lifecycle.
void import("./main").catch(async (cause: unknown) => {
  console.error("Cake desktop import failed", cause);
  const { app } = await import("electron");
  app.exit(1);
});
