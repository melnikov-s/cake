/* global process, console, fetch */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "out", "main", "native"));
const packagePath = join(root, "native", "dictation");

// Other platforms can still build Cake; Dictation reports its platform requirement.
if (process.platform === "darwin" && process.arch === "arm64") {
  await new Promise((resolveBuild, reject) => {
    const child = spawn(
      "xcrun",
      [
        "swift",
        "build",
        "--package-path",
        packagePath,
        "-c",
        "release",
        "--product",
        "cake-dictation",
      ],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveBuild()
        : reject(
            new Error(
              "Could not compile Cake's native dictation helper. Building from source requires Swift 6.2+; installed Cake users do not need developer tools.",
            ),
          ),
    );
  });
  const release = join(packagePath, ".build", "release");
  const binary = join(release, "cake-dictation");
  await stat(binary);
  await mkdir(output, { recursive: true });
  await cp(binary, join(output, "cake-dictation"));
  for (const entry of await readdir(release)) {
    if (entry.endsWith(".bundle"))
      await cp(join(release, entry), join(output, entry), { recursive: true });
  }
  const fluid = join(packagePath, ".build", "checkouts", "FluidAudio");
  await cp(join(fluid, "LICENSE"), join(output, "FluidAudio-LICENSE.txt"));
  await cp(join(fluid, "ThirdPartyLicenses"), join(output, "ThirdPartyLicenses"), {
    recursive: true,
  });
  // Ship the small detector with Cake. Enabling dictation must never fetch model data.
  const vad = JSON.parse(await readFile(join(packagePath, "vad-manifest.json"), "utf8"));
  const cache = join(packagePath, ".build", "cake-vad");
  for (const file of vad.files) {
    const cached = join(cache, file.path);
    let bytes;
    try {
      bytes = await readFile(cached);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const valid = (value) =>
      value?.length === file.bytes &&
      createHash("sha256").update(value).digest("hex") === file.sha256;
    if (!valid(bytes)) {
      const response = await fetch(
        `https://huggingface.co/${vad.repository}/resolve/${vad.revision}/${file.path}`,
      );
      if (!response.ok) throw new Error(`VAD model download failed: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!valid(bytes)) throw new Error(`VAD model checksum mismatch: ${file.path}`);
      await mkdir(dirname(cached), { recursive: true });
      await writeFile(cached, bytes);
    }
    await mkdir(dirname(join(output, file.path)), { recursive: true });
    await writeFile(join(output, file.path), bytes);
  }
  await cp(join(packagePath, "Silero-VAD-LICENSE.txt"), join(output, "Silero-VAD-LICENSE.txt"));
  console.log("[cake] Bundled Swift/Core ML dictation helper and local speech detector");
} else {
  await rm(output, { recursive: true, force: true });
}
