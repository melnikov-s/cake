import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdateChecks } from "../../../../src/services/electron/AppUpdateChecks";

const native = vi.hoisted(() => ({
  fetch: vi.fn(),
  dialog: vi.fn(),
  open: vi.fn(),
  shown: vi.fn(),
  closed: vi.fn(),
  notifications: [] as EventEmitter[],
}));
vi.mock("electron", () => ({
  net: { fetch: native.fetch },
  dialog: { showMessageBox: native.dialog },
  shell: { openExternal: native.open },
  Notification: class extends EventEmitter {
    constructor() {
      super();
      native.notifications.push(this);
    }
    show = native.shown;
    close = native.closed;
  },
}));

const update = {
  version: "0.2.0",
  downloadUrl:
    "https://github.com/melnikov-s/cake/releases/download/v0.2.0/Cake-0.2.0-mac-arm64.dmg",
  sha256: "a".repeat(64),
};
const application = { isPackaged: true, getVersion: () => "0.1.0" };
const respond = (value: unknown = update, status = 200) => {
  native.fetch.mockResolvedValue(new Response(JSON.stringify(value), { status }));
};

beforeEach(() => {
  vi.clearAllMocks();
  native.notifications = [];
  native.dialog.mockResolvedValue({ response: 1 });
  native.open.mockResolvedValue(undefined);
  respond();
});

describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "native update flow",
  () => {
    it("checks the public feed and opens a download only after the user chooses it", async () => {
      const checks = new AppUpdateChecks(application);
      await checks.check(false);
      expect(native.fetch.mock.calls[0]?.[0]).toBe(
        "https://github.com/melnikov-s/cake/releases/latest/download/latest-mac-arm64.json",
      );
      expect(native.dialog).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Cake 0.2.0 is available",
          detail: expect.stringContaining("quit Cake"),
          buttons: ["Download", "Later"],
        }),
      );
      expect(native.open).not.toHaveBeenCalled();
      respond();
      native.dialog.mockResolvedValue({ response: 0 });
      await checks.check(false);
      expect(native.open).toHaveBeenCalledExactlyOnceWith(update.downloadUrl);
    });

    it("notifies silently at launch and notification clicks open the external download", async () => {
      const checks = new AppUpdateChecks(application);
      await checks.check(true);
      expect(native.shown).toHaveBeenCalledOnce();
      expect(native.dialog).not.toHaveBeenCalled();
      expect(native.open).not.toHaveBeenCalled();
      native.notifications[0]?.emit("click");
      expect(native.open).toHaveBeenCalledWith(update.downloadUrl);
      checks.stop();
      expect(native.closed).toHaveBeenCalledOnce();
    });

    it("does not notify for equal or older versions", async () => {
      for (const version of ["0.1.0", "0.0.9"]) {
        respond({
          ...update,
          version,
          downloadUrl: `https://github.com/melnikov-s/cake/releases/download/v${version}/Cake-${version}-mac-arm64.dmg`,
        });
        await new AppUpdateChecks(application).check(true);
      }
      expect(native.shown).not.toHaveBeenCalled();
    });

    it("shows current status for a manual check", async () => {
      respond({
        ...update,
        version: "0.1.0",
        downloadUrl:
          "https://github.com/melnikov-s/cake/releases/download/v0.1.0/Cake-0.1.0-mac-arm64.dmg",
      });
      await new AppUpdateChecks(application).check(false);
      expect(native.dialog).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Cake 0.1.0 is up to date." }),
      );
    });

    it.each([404, 500])(
      "reports HTTP %i on manual checks without claiming up-to-date",
      async (status) => {
        respond({}, status);
        await new AppUpdateChecks(application).check(false);
        expect(native.dialog).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
        expect(native.open).not.toHaveBeenCalled();
      },
    );

    it("keeps offline launch failures quiet but explains failed manual checks", async () => {
      native.fetch.mockRejectedValue(new Error("Offline"));
      const checks = new AppUpdateChecks(application);
      await checks.check(true);
      expect(native.dialog).not.toHaveBeenCalled();
      await checks.check(false);
      expect(native.dialog).toHaveBeenCalledWith(expect.objectContaining({ detail: "Offline" }));
    });

    it("rejects malformed metadata and non-release download URLs", async () => {
      respond({ ...update, downloadUrl: "https://example.com/not-cake.dmg" });
      await new AppUpdateChecks(application).check(false);
      expect(native.dialog).toHaveBeenCalledWith(
        expect.objectContaining({ detail: "The release metadata is invalid." }),
      );
      expect(native.open).not.toHaveBeenCalled();
    });

    it("explains external-browser failures", async () => {
      native.dialog.mockResolvedValue({ response: 0 });
      native.open.mockRejectedValue(new Error("Browser unavailable"));
      await new AppUpdateChecks(application).check(false);
      expect(native.dialog).toHaveBeenLastCalledWith(
        expect.objectContaining({ detail: "Browser unavailable" }),
      );
    });

    it("does not check development builds or stopped app instances", async () => {
      const development = new AppUpdateChecks({ ...application, isPackaged: false });
      development.start();
      await development.check(false);
      const stopped = new AppUpdateChecks(application);
      stopped.stop();
      await stopped.check(false);
      expect(native.fetch).not.toHaveBeenCalled();
    });
  },
);
