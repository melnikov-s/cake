/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { mockImageClipboard } from "./image-clipboard-fixture";
import { imageClipboardData } from "../../../src/renderer/lib/image-clipboard";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("decodes the source and encodes full-size PNG pixels rather than copying its URL", async () => {
  const { image, drawImage, encode } = mockImageClipboard();
  expect(await imageClipboardData("data:image/webp;base64,source")).toBe(
    "data:image/png;base64,encoded",
  );
  expect(image.src).toBe("data:image/webp;base64,source");
  expect(image.crossOrigin).toBe("anonymous");
  expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
  expect(encode).toHaveBeenCalledWith("image/png");
  const canvas = encode.mock.contexts[0] as HTMLCanvasElement | undefined;
  expect(canvas?.width).toBe(80);
  expect(canvas?.height).toBe(20);
});

it("rejects unavailable/unsupported images and inaccessible pixels honestly", async () => {
  const { image, encode } = mockImageClipboard();
  image.decode.mockRejectedValueOnce(new Error("decode failed"));
  await expect(imageClipboardData("missing")).rejects.toThrow("unavailable or its format");
  expect(encode).not.toHaveBeenCalled();
  encode.mockImplementationOnce(() => {
    throw new DOMException("Tainted canvas");
  });
  await expect(imageClipboardData("remote")).rejects.toThrow("block access to its pixels");
  encode.mockReturnValueOnce("data:,");
  await expect(imageClipboardData("too-large")).rejects.toThrow("cannot be copied");
  image.naturalWidth = 0;
  await expect(imageClipboardData("empty")).rejects.toThrow("no pixels");
});
