/** Decode with Chromium so local/pasted images can be copied as PNG pixels, not a URL. */
export async function imageClipboardData(src: string): Promise<string> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = src;
  try {
    await image.decode();
  } catch {
    throw new Error("The image is unavailable or its format cannot be decoded.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height)
    throw new Error("The image has no pixels available to copy.");
  context.drawImage(image, 0, 0);
  try {
    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("PNG encoding failed");
    return dataUrl;
  } catch {
    throw new Error("The image cannot be copied. It may block access to its pixels.");
  }
}
