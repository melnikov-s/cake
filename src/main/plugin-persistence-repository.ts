import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { pluginIdSchema, pluginPersistenceKeySchema, pluginPersistenceRecordSchema, pluginPersistenceScopeSchema, type PluginPersistenceRecord, type PluginPersistenceScope } from "../plugin/plugin-contract";
import { SerializedFileWriter } from "./serialized-file-writer";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class PluginPersistenceRepository {
  private readonly writer = new SerializedFileWriter();
  private readonly updates = new Map<string, Promise<PluginPersistenceRecord>>();
  constructor(readonly root: string, readonly sourceRevision: () => string | undefined) {}

  private path(pluginId: string, key: string, scope: PluginPersistenceScope) {
    const parsedId = pluginIdSchema.parse(pluginId); pluginPersistenceKeySchema.parse(key); pluginPersistenceScopeSchema.parse(scope);
    return scope.kind === "global"
      ? join(this.root, "plugins", parsedId, "global", `${digest(key)}.json`)
      : join(this.root, "plugins", parsedId, "sessions", digest(scope.sessionId), `${digest(key)}.json`);
  }

  async read(pluginId: string, key: string, scope: PluginPersistenceScope): Promise<PluginPersistenceRecord | undefined> {
    try { return pluginPersistenceRecordSchema.parse(JSON.parse(await readFile(this.path(pluginId, key, scope), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async write(pluginId: string, key: string, scope: PluginPersistenceScope, value: unknown, expectedVersion?: number, sourceRevision = this.sourceRevision()) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Plugin state must be JSON-serializable");
    if (encoded.length > 1_000_000) throw new Error("Plugin state exceeds the 1 MB value limit");
    const parsedValue = pluginPersistenceRecordSchema.shape.value.parse(JSON.parse(encoded));
    const target = this.path(pluginId, key, scope);
    const previous = this.updates.get(target) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const current = await this.read(pluginId, key, scope);
      if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) throw new Error(`Plugin state changed concurrently: expected version ${expectedVersion}, found ${current?.version ?? 0}`);
      const record = pluginPersistenceRecordSchema.parse({ schemaVersion: 1, pluginId, key, scope, value: parsedValue, version: (current?.version ?? 0) + 1, sourceRevision, updatedAt: new Date().toISOString() });
      await mkdir(dirname(target), { recursive: true });
      await this.writer.write(target, `${JSON.stringify(record, null, 2)}\n`);
      return record;
    });
    this.updates.set(target, next);
    try { return await next; }
    finally { if (this.updates.get(target) === next) this.updates.delete(target); }
  }
}
