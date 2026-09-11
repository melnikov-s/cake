import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { KeyedSerialExecutor } from "../../../utils/KeyedSerialExecutor";

/** Atomically replaces text files, creating their directory on first write, and
 *  orders concurrent writes to the same path. */
export class AtomicFileWriter {
  private readonly writes = new KeyedSerialExecutor<string>();

  write(target: string, content: string) {
    return this.writes.run(target, async () => {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }
}
