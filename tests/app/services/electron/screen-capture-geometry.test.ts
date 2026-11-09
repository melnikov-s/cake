import { describe, expect, it, vi } from "vitest";
import { automaticCaptureTopInset } from "../../../../src/services/electron/screen-capture-geometry";

type RunScript = NonNullable<Parameters<typeof automaticCaptureTopInset>[4]>;
const signal = new AbortController().signal;
const display = {
  id: 17,
  bounds: { x: -1440, y: -900, width: 1440, height: 900 },
  workArea: { x: -1440, y: -875, width: 1440, height: 825 },
};

describe("automatic menu-bar exclusion", () => {
  it.each([
    [900, 25],
    [1800, 50],
    [1200, 34],
  ])(
    "converts offset display DIPs to the actual %ipx bitmap, rounding inward",
    async (height, expected) => {
      const run = vi.fn();
      expect(await automaticCaptureTopInset("darwin", display, height, signal, run)).toBe(expected);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each([-900, 0, 600])(
    "uses each display's own origin at y=%i, not the primary display",
    async (y) => {
      expect(
        await automaticCaptureTopInset(
          "darwin",
          {
            ...display,
            bounds: { ...display.bounds, y },
            workArea: { ...display.workArea, y: y + 25 },
          },
          1800,
          signal,
        ),
      ).toBe(50);
    },
  );

  it("does not exclude the Dock, side insets or window title bars", async () => {
    expect(
      await automaticCaptureTopInset(
        "darwin",
        {
          ...display,
          workArea: { x: -1380, y: -875, width: 1380, height: 800 },
        },
        1800,
        signal,
      ),
    ).toBe(50);
  });

  it.each([0, -10, NaN])("uses AppKit for hidden/unavailable top inset %s", async (inset) => {
    const run = vi.fn<RunScript>(async () => "37");
    expect(
      await automaticCaptureTopInset(
        "darwin",
        {
          ...display,
          workArea: { ...display.workArea, y: display.bounds.y + inset },
        },
        1800,
        signal,
        run,
      ),
    ).toBe(74);
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("screen.safeAreaInsets.top"),
      ["17"],
      signal,
    );
    expect(run.mock.calls[0]?.[0]).toContain("NSStatusBar.systemStatusBar.thickness");
  });

  it.each(["", "NaN", "-1", "0", "900", "901"])(
    "fails closed for unavailable/invalid native geometry %j",
    async (value) => {
      const run = vi.fn(async () => value);
      expect(
        await automaticCaptureTopInset(
          "darwin",
          {
            ...display,
            workArea: { ...display.bounds },
          },
          1800,
          signal,
          run,
        ),
      ).toBeNull();
    },
  );

  it("fails closed when native geometry cannot be read", async () => {
    expect(
      await automaticCaptureTopInset(
        "darwin",
        {
          ...display,
          workArea: { ...display.bounds },
        },
        1800,
        signal,
        async () => {
          throw new Error("Unavailable");
        },
      ),
    ).toBeNull();
  });

  it("leaves non-macOS automatic geometry unchanged", async () => {
    const run = vi.fn();
    expect(await automaticCaptureTopInset("linux", display, 1800, signal, run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
