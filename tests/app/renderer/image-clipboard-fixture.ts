import { vi } from "vitest";

/** Only the browser decoding/canvas boundary is fake; clipboard preparation stays real. */
export function mockImageClipboard() {
  const image = {
    src: "",
    crossOrigin: "",
    naturalWidth: 80,
    naturalHeight: 20,
    decode: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal(
    "Image",
    class {
      constructor() {
        return image;
      }
    },
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue("data:image/png;base64,encoded");
  return { image, drawImage, encode };
}
