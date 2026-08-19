import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  pluginIdSchema,
  pluginPersistenceKeySchema,
  pluginPersistenceRecordSchema,
  pluginPersistenceScopeSchema,
  type PluginPersistenceRecord,
  type PluginPersistenceScope,
  type PluginPersistenceValue,
} from "../plugin/plugin-contract";
import { AtomicFileWriter } from "./atomic-file-writer";
import { KeyedSerialExecutor } from "./keyed-serial-executor";
import { hasFileErrorCode } from "./file-errors";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class PluginPersistenceRepository {
  private readonly writer = new AtomicFileWriter();
  private readonly updates = new KeyedSerialExecutor<string>();
  constructor(
    readonly root: string,
    readonly sourceRevision: () => string | undefined,
  ) {}

  private path(pluginId: string, key: string, scope: PluginPersistenceScope) {
    const parsedId = pluginIdSchema.parse(pluginId);
    pluginPersistenceKeySchema.parse(key);
    pluginPersistenceScopeSchema.parse(scope);
    return scope.kind === "global"
      ? join(this.root, "plugins", parsedId, "global", `${digest(key)}.json`)
      : join(
          this.root,
          "plugins",
          parsedId,
          "sessions",
          digest(scope.sessionId),
          `${digest(key)}.json`,
        );
  }

  async read(
    pluginId: string,
    key: string,
    scope: PluginPersistenceScope,
  ): Promise<PluginPersistenceRecord | undefined> {
    try {
      return pluginPersistenceRecordSchema.parse(
        JSON.parse(await readFile(this.path(pluginId, key, scope), "utf8")),
      );
    } catch (error) {
      if (hasFileErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async write(
    pluginId: string,
    key: string,
    scope: PluginPersistenceScope,
    value: PluginPersistenceValue,
    expectedVersion?: number,
    sourceRevision = this.sourceRevision(),
  ) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Plugin state must be JSON-serializable");
    if (encoded.length > 1_000_000) throw new Error("Plugin state exceeds the 1 MB value limit");
    const parsedValue = pluginPersistenceRecordSchema.shape.value.parse(JSON.parse(encoded));
    const target = this.path(pluginId, key, scope);
    return this.updates.run(target, async () => {
      const current = await this.read(pluginId, key, scope);
      if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion)
        throw new Error(
          `Plugin state changed concurrently: expected version ${expectedVersion}, found ${current?.version ?? 0}`,
        );
      const record = pluginPersistenceRecordSchema.parse({
        schemaVersion: 1,
        pluginId,
        key,
        scope,
        value: parsedValue,
        version: (current?.version ?? 0) + 1,
        sourceRevision,
        updatedAt: new Date().toISOString(),
      });
      await mkdir(dirname(target), { recursive: true });
      await this.writer.write(target, `${JSON.stringify(record, null, 2)}\n`);
      return record;
    });
  }
}
