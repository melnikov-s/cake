// Loaded only into isolated queue fixtures via NODE_OPTIONS, never the app.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

if (process.argv[2] === "supervise" && process.env.CAKE_TEST_CLEANUP_FAULT) {
  const root = process.env.CAKE_TEST_CLEANUP_ROOT;
  const queuePath = join(root, "queue.sqlite");
  const kill = process.kill.bind(process);
  let injected = false;
  process.kill = (pid, signal) => {
    if (injected && signal !== 0)
      appendFileSync(join(root, "cleanup-signals"), `${pid} ${signal}\n`);
    if (!injected && pid < -1 && signal === 0 && existsSync(queuePath)) {
      const db = new DatabaseSync(queuePath);
      let registered;
      try {
        registered = db.prepare("SELECT pid FROM electron_groups WHERE pid = ?").get(-pid);
      } finally {
        db.close();
      }
      if (registered) {
        injected = true;
        const code = process.env.CAKE_TEST_CLEANUP_FAULT;
        throw Object.assign(new Error(`injected registration cleanup ${code}`), { code });
      }
    }
    return kill(pid, signal);
  };
}
