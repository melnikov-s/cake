import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { KeyedSerialExecutor } from "./keyed-serial-executor";

/** Atomically replaces text files and orders concurrent writes to the same path. */
export class AtomicFileWriter {
  private readonly writes = new KeyedSerialExecutor<string>();

  write(target: string, content: string) {
    return this.writes.run(target, async () => {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }
}
