import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { Cache, Effect, Exit, Option, Schema } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../../../contracts/conversations/session-contract";
import { textFromContent } from "./tool-projection";
import { visibleUserMessageText } from "./user-message-transport";
import { stripPresentationModeReminder } from "../../../contracts/conversations/presentation-mode-reminders";
import { stripResponseModeReminder } from "../../../contracts/conversations/response-mode-reminders";

const PAGE_BYTES = 64 * 1024;
// Only a candidate title record is materialized, never a transcript. Oversized
// candidates fail explicitly rather than silently returning an incorrect title.
const MAX_TITLE_RECORD_BYTES = 8 * 1024 * 1024;
const headerSchema = Schema.Struct({ type: Schema.Literal("session"), id: Schema.String });
const infoSchema = Schema.Struct({
  type: Schema.Literal("session_info"),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const userSchema = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({ role: Schema.Literal("user"), content: Schema.Unknown }),
});

class SessionTitleError extends Schema.TaggedError<SessionTitleError>()("SessionTitleError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}
class ChangedTitleFile extends Error {}

type FileStat = Awaited<ReturnType<typeof metadata>>;
async function metadata(path: string) {
  const canonicalPath = await realpath(path);
  const info = await stat(canonicalPath, { bigint: true });
  if (!info.isFile() || info.size === 0n) {
    throw new Error(`Session title requires a nonempty regular file: ${path}`);
  }
  return {
    canonicalPath,
    size: Number(info.size),
    fingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
  };
}

/** Measurement hook counts actual filesystem reads, not cache capacity or estimates. */
export interface SessionTitleReadMetrics {
  bytesRead: number;
  recordsParsed: number;
}

class TitleFileReader {
  private page = Buffer.alloc(0);
  private pageStart = -1;
  readonly metrics: SessionTitleReadMetrics = { bytesRead: 0, recordsParsed: 0 };

  constructor(
    private readonly file: FileHandle,
    readonly size: number,
    private readonly signal: AbortSignal,
  ) {}

  async read(start: number, length: number): Promise<Buffer> {
    this.signal.throwIfAborted();
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const pageStart = Math.floor(start / PAGE_BYTES) * PAGE_BYTES;
      if (pageStart !== this.pageStart) {
        this.signal.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Math.min(PAGE_BYTES, this.size - pageStart));
        const { bytesRead } = await this.file.read(buffer, 0, buffer.length, pageStart);
        this.metrics.bytesRead += bytesRead;
        if (bytesRead !== buffer.length) throw new ChangedTitleFile("Session file truncated");
        this.page = buffer;
        this.pageStart = pageStart;
        // Even a hot filesystem must not monopolize the main event loop.
        await setImmediate(undefined, { signal: this.signal });
      }
      const offset = start - pageStart;
      const count = Math.min(remaining, this.page.length - offset);
      chunks.push(this.page.subarray(offset, offset + count));
      start += count;
      remaining -= count;
    }
    return chunks.length === 1 ? (chunks[0] ?? Buffer.alloc(0)) : Buffer.concat(chunks);
  }

  async *lines(reverse: boolean) {
    let boundary = reverse ? this.size : 0;
    for (
      let pageStart = reverse ? Math.floor((this.size - 1) / PAGE_BYTES) * PAGE_BYTES : 0;
      reverse ? pageStart >= 0 : pageStart < this.size;
      pageStart += reverse ? -PAGE_BYTES : PAGE_BYTES
    ) {
      const page = await this.read(pageStart, Math.min(PAGE_BYTES, this.size - pageStart));
      let newline = reverse ? page.lastIndexOf(10) : page.indexOf(10);
      while (newline !== -1) {
        const position = pageStart + newline;
        const start = reverse ? position + 1 : boundary;
        const end = reverse ? boundary : position;
        boundary = reverse ? position : position + 1;
        if (end > start) yield { start, length: end - start };
        newline = reverse
          ? newline === 0
            ? -1
            : page.lastIndexOf(10, newline - 1)
          : page.indexOf(10, newline + 1);
      }
    }
    if (reverse ? boundary > 0 : boundary < this.size) {
      yield { start: reverse ? 0 : boundary, length: reverse ? boundary : this.size - boundary };
    }
  }

  async parse(line: { start: number; length: number }) {
    if (line.length > MAX_TITLE_RECORD_BYTES) {
      throw new Error(`Session title candidate exceeds ${MAX_TITLE_RECORD_BYTES} bytes`);
    }
    const text = (await this.read(line.start, line.length)).toString("utf8");
    this.metrics.recordsParsed++;
    try {
      const value: unknown = JSON.parse(text);
      return value;
    } catch {
      // Pi skips malformed/unfinished physical lines. Never repair them here.
      return undefined;
    }
  }

  async prefix(line: { start: number; length: number }) {
    return (await this.read(line.start, Math.min(512, line.length))).toString("utf8");
  }
}

// Pi writes type first. This is only a skip optimization: noncanonical ordering
// (including escaped keys) goes through JSON + Schema decoding instead.
const leadingType = /^\s*\{\s*"type"\s*:\s*"([^"\\]+)"\s*[,}]/;
const leadingMessageRole = /"message"\s*:\s*\{\s*"role"\s*:\s*"([^"\\]+)"\s*[,}]/;

async function readTitle(reader: TitleFileReader) {
  let sessionId: string | undefined;
  for await (const line of reader.lines(false)) {
    const value = await reader.parse(line);
    if (value === undefined || value === null) continue;
    const header = Schema.decodeUnknownOption(headerSchema)(value);
    if (Option.isNone(header)) throw new Error("Invalid Pi session header");
    sessionId = header.value.id;
    break;
  }
  if (sessionId === undefined) throw new Error("Missing Pi session header");

  // getSessionName uses the latest physical record, not the active branch.
  for await (const line of reader.lines(true)) {
    const type = leadingType.exec(await reader.prefix(line))?.[1];
    if (type !== undefined && type !== "session_info") continue;
    const info = Schema.decodeUnknownOption(infoSchema)(await reader.parse(line));
    if (Option.isNone(info)) continue;
    const name = info.value.name?.trim();
    if (name) return name.slice(0, SESSION_TITLE_MAX_LENGTH);
    break; // An explicit clear must not resurrect an earlier name.
  }

  // Like getEntries(), this visits file order, including abandoned branches.
  for await (const line of reader.lines(false)) {
    const prefix = await reader.prefix(line);
    const type = leadingType.exec(prefix)?.[1];
    if (type !== undefined && type !== "message") continue;
    const role = leadingMessageRole.exec(prefix)?.[1];
    if (role !== undefined && role !== "user") continue;
    const user = Schema.decodeUnknownOption(userSchema)(await reader.parse(line));
    if (Option.isNone(user)) continue;
    const text = visibleUserMessageText(
      stripResponseModeReminder(
        stripPresentationModeReminder(textFromContent(user.value.message.content)),
      ),
    ).trim();
    if (text) return text.slice(0, SESSION_TITLE_MAX_LENGTH);
  }
  return sessionId.slice(0, SESSION_TITLE_MAX_LENGTH);
}

async function readStableTitle(
  before: FileStat,
  signal: AbortSignal,
  measured?: (metrics: SessionTitleReadMetrics) => void,
) {
  const file = await open(before.canonicalPath, "r");
  const reader = new TitleFileReader(file, before.size, signal);
  try {
    const title = await readTitle(reader);
    const after = await metadata(before.canonicalPath);
    const opened = await file.stat({ bigint: true });
    if (
      before.fingerprint !== after.fingerprint ||
      `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}:${opened.ctimeNs}` !==
        before.fingerprint
    )
      throw new ChangedTitleFile("Session file changed while reading its title");
    return title;
  } finally {
    await file.close();
    measured?.(reader.metrics);
  }
}

/**
 * Process-owned, disposable derived metadata only. No transcript entries, file
 * handles, persistent index, migration, or listeners survive a lookup. Effect's
 * cache bounds memory and shares concurrent misses; failures are not retained.
 * Fingerprint keys deliberately rescan changed files: size growth is not proof
 * that an external writer only appended (it may also have renamed older data).
 */
export const makeSessionTitleReader = Effect.fn("Pi.makeSessionTitleReader")(function* (
  options: { capacity?: number; measured?: (metrics: SessionTitleReadMetrics) => void } = {},
) {
  const cache = yield* Cache.makeWith(
    (key: string) => {
      const separator = key.indexOf("\0");
      const path = key.slice(0, separator);
      return Effect.tryPromise({
        try: async (signal) => {
          const before = await metadata(path);
          if (before.fingerprint !== key.slice(separator + 1))
            throw new ChangedTitleFile("Session file changed before title read");
          return readStableTitle(before, signal, options.measured);
        },
        catch: (cause) => new SessionTitleError({ path, cause }),
      });
    },
    {
      capacity: options.capacity ?? 1_024,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Infinity : 0),
    },
  );
  return Effect.fn("Pi.sessionTitleFromFile")(function* (path: string, _cwd: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* Effect.tryPromise({
        try: () => metadata(path),
        catch: (cause) => new SessionTitleError({ path, cause }),
      });
      const title = yield* Cache.get(cache, `${result.canonicalPath}\0${result.fingerprint}`).pipe(
        Effect.result,
      );
      if (title._tag === "Success") {
        // Also check the caller's route (a symlink may have been retargeted).
        const after = yield* Effect.tryPromise({
          try: () => metadata(path),
          catch: (cause) => new SessionTitleError({ path, cause }),
        });
        if (
          result.canonicalPath === after.canonicalPath &&
          result.fingerprint === after.fingerprint
        )
          return title.success;
      } else if (!(title.failure.cause instanceof ChangedTitleFile)) {
        return yield* Effect.fail(title.failure);
      }
    }
    return yield* Effect.fail(
      new SessionTitleError({
        path,
        cause: new ChangedTitleFile(`Session file changed while reading its title: ${path}`),
      }),
    );
  });
});

// Lazy acquisition: importing discovery performs no filesystem work or scan.
const reader = Effect.runSync(Effect.cached(makeSessionTitleReader()));
export const sessionTitleFromFile = Effect.fn("Pi.sessionTitleFromFile")(function* (
  path: string,
  cwd: string,
) {
  return yield* (yield* reader)(path, cwd);
});
