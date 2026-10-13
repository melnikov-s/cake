import { beforeEach, expect, it, vi } from "vitest";
import { reportMainFailure } from "../../../src/main/report-main-failure";

const native = vi.hoisted(() => ({
  whenReady: vi.fn(async () => {}),
  focused: vi.fn(),
  windows: vi.fn(() => []),
  showMessageBox: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { whenReady: native.whenReady },
  BrowserWindow: { getFocusedWindow: native.focused, getAllWindows: native.windows },
  dialog: { showMessageBox: native.showMessageBox },
  clipboard: { writeText: native.writeText },
}));
beforeEach(() => vi.clearAllMocks());

it("keeps fatal diagnostics pending until the native dialog is acknowledged", async () => {
  let acknowledge!: (result: { response: number }) => void;
  native.showMessageBox.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  let completed = false;
  const reporting = reportMainFailure("Backend failed: full stack").then(() => {
    completed = true;
  });
  await vi.waitFor(() => expect(native.showMessageBox).toHaveBeenCalledOnce());
  expect(native.showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({ detail: "Backend failed: full stack" }),
  );
  expect(completed).toBe(false);
  acknowledge({ response: 0 });
  await reporting;
  expect(completed).toBe(true);
});

it("parents the error to the active window and keeps it open after copying details", async () => {
  const parent = { isDestroyed: () => false };
  native.focused.mockReturnValueOnce(parent);
  native.showMessageBox
    .mockResolvedValueOnce({ response: 1 })
    .mockResolvedValueOnce({ response: 0 });
  await reportMainFailure("Failure details");
  expect(native.showMessageBox).toHaveBeenCalledTimes(2);
  expect(native.showMessageBox).toHaveBeenCalledWith(
    parent,
    expect.objectContaining({ type: "error" }),
  );
  expect(native.writeText).toHaveBeenCalledWith("Failure details");
});
