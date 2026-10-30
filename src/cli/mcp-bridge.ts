#!/usr/bin/env node
// This process owns only the stdio connection; the running Cake backend owns work.
import { connect } from "node:net";
import process from "node:process";
import console from "node:console";
import { isAbsolute, join } from "node:path";

const directory = process.argv[2];
if (process.argv.length !== 3 || !directory || !isAbsolute(directory)) {
  console.error("Usage: cake-mcp /absolute/private/mcp-directory");
  process.exit(1);
}
const socket = connect(join(directory, "cake.sock"));
socket.on("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (error) => {
  console.error(
    `Cannot connect to Cake local MCP: ${error.message}. Start Cake with CAKE_LOCAL_MCP configured.`,
  );
  process.exitCode = 1;
});
socket.on("close", () => {
  process.stdin.unpipe(socket);
  process.stdin.destroy();
});
process.stdout.on("error", () => socket.destroy());
process.stdin.on("error", () => socket.destroy());
process.on("SIGTERM", () => socket.destroy());
process.on("SIGINT", () => socket.destroy());
