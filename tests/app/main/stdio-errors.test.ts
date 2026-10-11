import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { installStdioErrorHandlers } from "../../../src/main/stdio-errors";

describe("main-process diagnostic streams", () => {
  it("tolerates repeated broken-pipe errors on both output streams", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    installStdioErrorHandlers(stdout, stderr);

    for (const stream of [stdout, stderr]) {
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      expect(() => stream.emit("error", error)).not.toThrow();
      expect(() => stream.emit("error", error)).not.toThrow();
    }
  });

  it("handles an error emitted by a failed write without an uncaught exception", async () => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(error);
      },
    });
    installStdioErrorHandlers(stream);
    // 'close' is ordered after the write failure and error event. Do not add another
    // error listener that could mask the missing production handler.
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    stream.write("diagnostic output");
    await closed;
    expect(stream.errored).toBe(error);
  });

  it.each(["EIO", "ENOSPC", "ECONNRESET", undefined])(
    "keeps non-EPIPE errors visible (%s)",
    (code) => {
      const stream = new PassThrough();
      installStdioErrorHandlers(stream);
      const error = Object.assign(new Error("unrelated stream failure"), { code });
      expect(() => stream.emit("error", error)).toThrow(error);
    },
  );

  it("does not alter successful output", () => {
    const stream = new PassThrough();
    installStdioErrorHandlers(stream);
    stream.write("warning text\n");
    expect(stream.read().toString()).toBe("warning text\n");
  });
});
