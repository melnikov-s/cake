import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export class SerializedFileWriter {
  private pending: Promise<void> = Promise.resolve();

  write(target: string, content: string) {
    const operation = async () => {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
