import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import {
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { requirePathInsideRoot } from "./workspace-paths";

/** Pi read/search definitions whose filesystem operations cannot escape the canonical workspace. */
export function createWorkspaceReadTools(workspaceRoot: string): ToolDefinition[] {
  return [
    defineTool(
      createReadToolDefinition(workspaceRoot, {
        operations: {
          async access(path) {
            await access(await requirePathInsideRoot(workspaceRoot, path), constants.R_OK);
          },
          async readFile(path) {
            return readFile(await requirePathInsideRoot(workspaceRoot, path));
          },
        },
      }),
    ),
    defineTool(
      createLsToolDefinition(workspaceRoot, {
        operations: {
          async exists(path) {
            try {
              await access(await requirePathInsideRoot(workspaceRoot, path), constants.F_OK);
              return true;
            } catch {
              return false;
            }
          },
          async stat(path) {
            return stat(await requirePathInsideRoot(workspaceRoot, path));
          },
          async readdir(path) {
            return readdir(await requirePathInsideRoot(workspaceRoot, path));
          },
        },
      }),
    ),
  ];
}
