import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { installProcessErrorHandlers } from "../../../src/main/process-errors";

it.each(["uncaughtException", "unhandledRejection"])(
  "reports %s and waits for acknowledgment before exit",
  async (event) => {
    const process = new EventEmitter();
    let acknowledge!: () => void;
    const report = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const exit = vi.fn();
    installProcessErrorHandlers(process, report, exit);
    const error = new Error("Pi startup failed");
    process.emit(event, error);
    expect(report).toHaveBeenCalledWith(error.stack);
    expect(exit).not.toHaveBeenCalled();
    process.emit(event, new Error("secondary failure"));
    expect(report).toHaveBeenCalledOnce();
    acknowledge();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
  },
);

it("exits if the native reporter itself fails", async () => {
  const process = new EventEmitter();
  const exit = vi.fn();
  installProcessErrorHandlers(
    process,
    async () => {
      throw new Error("Native dialog failed");
    },
    exit,
  );
  process.emit("uncaughtException", "Startup failed");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
});
