import type { ChildProcess } from "node:child_process";

/** Capture closure immediately after a detached spawn; only this fixture's group is owned. */
export function processGroupFinalizer(child: ChildProcess): () => Promise<void> {
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  return async () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await closed;
  };
}
