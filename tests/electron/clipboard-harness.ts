import type { ElectronApplication } from "@playwright/test";
import type { ClipboardItem } from "electron";

export function saveClipboardSnapshot(application: ElectronApplication, key: string) {
  return application.evaluate(async ({ clipboard, ClipboardItem }, key) => {
    // Read-side ClipboardItems cannot be written back. Materialize every original
    // format before a test changes the system clipboard, including custom formats.
    const snapshot = await Promise.all(
      (await clipboard.read()).map(
        async (item) =>
          new ClipboardItem(
            Object.fromEntries(
              await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
            ),
          ),
      ),
    );
    Reflect.set(globalThis, key, snapshot);
  }, key);
}

export function restoreClipboardSnapshot(application: ElectronApplication, key: string) {
  return application.evaluate(async ({ clipboard }, key) => {
    const snapshot = Reflect.get(globalThis, key) as ClipboardItem[] | undefined;
    if (!snapshot) throw new Error("No saved clipboard snapshot");
    if (snapshot.length) await clipboard.write(snapshot);
    else clipboard.clear();
    Reflect.deleteProperty(globalThis, key);
  }, key);
}

export function readClipboardImage(application: ElectronApplication) {
  return application.evaluate(async ({ clipboard, nativeImage }) => {
    const item = (await clipboard.read()).find((item) => item.types.includes("image/png"));
    if (!item) throw new Error("No PNG image on the clipboard");
    const png = await item.getType("image/png");
    const image = nativeImage.createFromBuffer(Buffer.from(await png.arrayBuffer()));
    return {
      size: image.getSize(),
      pixels: image.toBitmap().toString("base64"),
      data: image.toPNG().toString("base64"),
      text: await clipboard.readText(),
    };
  });
}
