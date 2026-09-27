import type { Attachment } from "../../ipc/session-contract";
import { ClientError } from "./Client";

/** Browser File objects never leave this tab. Opaque tokens are only resolved here, not by the backend. */
export class BrowserFiles {
  private readonly files = new Map<string, File>();

  choose(): Promise<ReadonlyArray<Attachment>> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.hidden = true;
      document.body.append(input);
      let settled = false;
      let selectionStarted = false;
      const finish = (files: ReadonlyArray<Attachment>) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("focus", onFocus);
        input.remove();
        resolve(files);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("focus", onFocus);
        input.remove();
        reject(error);
      };
      const onFocus = () =>
        setTimeout(() => {
          if (!selectionStarted) finish([]);
        }, 300);
      window.addEventListener("focus", onFocus, { once: true });
      input.addEventListener("cancel", () => finish([]), { once: true });
      input.addEventListener(
        "change",
        () => {
          selectionStarted = true;
          try {
            const selected = Array.from(input.files ?? []).slice(0, 20);
            for (const file of selected)
              if (
                !file.size ||
                file.size > (file.type.startsWith("image/") ? 15_000_000 : 8 * 1024 * 1024)
              )
                throw new Error("Selected file is too large or empty");
            void Promise.all(
              selected.map(async (file): Promise<Attachment> => {
                if (/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type)) {
                  const data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = () => reject(reader.error);
                    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
                    reader.readAsDataURL(file);
                  });
                  return { kind: "image", name: file.name, mimeType: file.type, data };
                }
                const path = `browser-file:${crypto.randomUUID()}`;
                this.files.set(path, file);
                return { kind: "file", name: file.name, path };
              }),
            ).then(finish, fail);
          } catch (error) {
            fail(error);
          }
        },
        { once: true },
      );
      input.click();
    });
  }

  get(path: string): File {
    const file = this.files.get(path);
    if (!file)
      throw new ClientError(
        "rejected",
        "filesystem.browser-selection",
        "Selected browser file is no longer available. Select it again.",
        "File grant expired on refresh",
      );
    return file;
  }
}

export async function browserFileChunk(file: File, offset: number): Promise<string> {
  const bytes = new Uint8Array(await file.slice(offset, offset + 192 * 1024).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
