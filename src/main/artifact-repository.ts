import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactRecordSchema,
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1
} from "../ipc/artifact-contract";
import { AtomicFileWriter } from "./atomic-file-writer";
import { KeyedSerialExecutor } from "./keyed-serial-executor";

interface StoredArtifactMetadata {
  protocol: "cake.artifact/v1";
  id: string;
  sessionId: string;
  workspacePath: string;
  revision: number;
  kind: CakeArtifactV1["kind"];
  digest: string;
  createdAt: string;
  updatedAt: string;
}

export class ArtifactRepository {
  private readonly updates = new KeyedSerialExecutor<string>();
  private readonly writer = new AtomicFileWriter();
  constructor(private readonly root: string) {}

  async upsert(workspacePath: string, input: unknown): Promise<ArtifactRecord> {
    const artifact = parseArtifactInput(input);
    const key = this.recordPath(workspacePath, artifact.sessionId, artifact.id);
    return this.updates.run(key, async () => {
      const existing = await this.get(workspacePath, artifact.sessionId, artifact.id);
      if (existing && artifact.revision !== existing.artifact.revision + 1) {
        throw new Error(`Artifact ${artifact.id} revision must advance from ${existing.artifact.revision} to ${existing.artifact.revision + 1}`);
      }
      if (!existing && artifact.revision !== 1) throw new Error(`New artifact ${artifact.id} must start at revision 1`);

      const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
      const digest = createHash("sha256").update(serialized).digest("hex");
      const now = new Date().toISOString();
      const record = artifactRecordSchema.parse({
        artifact,
        workspacePath,
        digest,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
      await mkdir(this.blobDirectory(), { recursive: true, mode: 0o700 });
      await mkdir(this.recordDirectory(workspacePath, artifact.sessionId), { recursive: true, mode: 0o700 });
      await this.writer.write(this.blobPath(digest), serialized);
      await this.writer.write(key, `${JSON.stringify(toMetadata(record), null, 2)}\n`);
      return record;
    });
  }

  async get(workspacePath: string, sessionId: string, artifactId: string): Promise<ArtifactRecord | undefined> {
    try {
      const metadata = JSON.parse(await readFile(this.recordPath(workspacePath, sessionId, artifactId), "utf8")) as StoredArtifactMetadata;
      const artifact = JSON.parse(await readFile(this.blobPath(metadata.digest), "utf8"));
      return artifactRecordSchema.parse({ artifact, ...metadata });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async listSession(workspacePath: string, sessionId: string): Promise<ArtifactRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.recordDirectory(workspacePath, sessionId));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const metadata = JSON.parse(await readFile(join(this.recordDirectory(workspacePath, sessionId), name), "utf8")) as StoredArtifactMetadata;
      return this.get(metadata.workspacePath, metadata.sessionId, metadata.id);
    }));
    return records.filter((record): record is ArtifactRecord => Boolean(record)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async linkSession(record: ArtifactRecord, sessionId: string): Promise<void> {
    await mkdir(this.recordDirectory(record.workspacePath, sessionId), { recursive: true, mode: 0o700 });
    await this.writer.write(this.recordPath(record.workspacePath, sessionId, record.artifact.id), `${JSON.stringify(toMetadata(record), null, 2)}\n`);
  }

  async exportMarkdown(workspacePath: string, sessionId: string): Promise<string> {
    const records = await this.listSession(workspacePath, sessionId);
    return records.map(({ artifact }) => `## ${artifact.title ?? artifact.id}\n\n${artifact.fallback.markdown}`).join("\n\n---\n\n");
  }

  private blobDirectory() { return join(this.root, "blobs"); }
  private blobPath(digest: string) { return join(this.blobDirectory(), `${digest}.json`); }
  private recordDirectory(workspacePath: string, sessionId: string) { return join(this.root, "sessions", digestKey(workspacePath), digestKey(sessionId)); }
  private recordPath(workspacePath: string, sessionId: string, artifactId: string) { return join(this.recordDirectory(workspacePath, sessionId), `${digestKey(artifactId)}.json`); }
}

function toMetadata(record: ArtifactRecord): StoredArtifactMetadata {
  return {
    protocol: "cake.artifact/v1",
    id: record.artifact.id,
    sessionId: record.artifact.sessionId,
    workspacePath: record.workspacePath,
    revision: record.artifact.revision,
    kind: record.artifact.kind,
    digest: record.digest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function digestKey(value: string) { return createHash("sha256").update(value).digest("hex"); }

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
