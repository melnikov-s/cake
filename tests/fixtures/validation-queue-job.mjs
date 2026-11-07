import process from "node:process";
import { watch, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const [root, name, mode = "wait", ...args] = process.argv.slice(2);
const file = (suffix) => join(root, `${name}.${suffix}`);
writeFileSync(file("started"), JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
if (mode === "echo") {
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  console.log(JSON.stringify({ args, stdin, cwd: process.cwd() }));
  console.error("fake-stderr");
  process.exit(Number(args[0]));
}
if (mode === "child-signal") process.kill(process.pid, "SIGTERM");
if (mode === "tree")
  spawn(process.execPath, [process.argv[1], root, `${name}-descendant`], { stdio: "ignore" });
if (mode === "nested-electron") {
  const { runElectronCommand } = await import("../../scripts/electron-run-queue.mjs");
  process.exitCode = await runElectronCommand(
    process.execPath,
    [process.argv[1], root, `${name}-electron`, "tree"],
    { queuePath: args[0] },
  );
} else if (mode === "nested") {
  const { runValidationCommand } = await import("../../scripts/validation-queue.mjs");
  process.exitCode = await runValidationCommand(
    process.execPath,
    [process.argv[1], root, `${name}-nested`],
    { queuePath: args[0], label: "nested fake job" },
  );
} else {
  process.on("SIGINT", () => {
    writeFileSync(file("signal"), "SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    writeFileSync(file("signal"), "SIGTERM");
    process.exit(0);
  });
  const check = () => {
    if (existsSync(file("release"))) process.exit(Number(readFileSync(file("release"), "utf8")));
  };
  watch(root, check);
  check();
}
