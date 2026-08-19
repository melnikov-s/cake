import type { Attachment } from "../ipc/session-contract";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the pasted image"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const data = result.slice(result.indexOf(",") + 1);
      if (data.length > 20_000_000)
        reject(new Error(`${file.name || "Pasted image"} is too large (15 MB maximum)`));
      else resolve(data);
    };
    reader.readAsDataURL(file);
  });
}

export async function pastedImageAttachments(files: readonly File[], availableSlots: number) {
  const images = files
    .filter((file) => file.type.startsWith("image/"))
    .slice(0, Math.max(0, availableSlots));
  return Promise.all(
    images.map(async (file, index): Promise<Extract<Attachment, { kind: "image" }>> => ({
      kind: "image",
      name: file.name || `Pasted image ${index + 1}`,
      mimeType: file.type,
      data: await fileToBase64(file),
    })),
  );
}
