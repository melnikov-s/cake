import { basename, dirname, join, resolve } from "node:path";
import { rm } from "node:fs/promises";

export const durableChatDatabase = (sessionDirectory: string) =>
  join(dirname(sessionDirectory), "coordinator.sqlite");
const isDurableChatDirectory = (directory: string) =>
  basename(dirname(directory)) === "global-chat" && basename(directory) === "sessions";

/** Explicit clean-start cutover. Never traverse into a Project Session namespace. */
export async function purgeLegacyGlobalChatHistory(
  directory: string,
  resolvedDirectory = join(dirname(directory), "resolved-sessions"),
) {
  if (
    !isDurableChatDirectory(directory) ||
    resolve(resolvedDirectory) !== resolve(dirname(directory), "resolved-sessions")
  )
    throw new Error("Refusing to clear a non-global Cake Chat namespace");
  await rm(directory, { recursive: true, force: true });
  await rm(resolvedDirectory, { recursive: true, force: true });
}
