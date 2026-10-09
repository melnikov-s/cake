/* global process, console, fetch, AbortSignal */
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forwardSwiftBuildDiagnostics } from "./swift-build-diagnostics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "out", "main", "native"));
const packagePath = join(root, "native", "speech");
const wheel = {
  // Official MLX 0.31.1 kernels, matching the C++ core in pinned mlx-swift 0.31.3.
  // Used only as a build-time shader artifact. Never install/import Python or ship its dylibs.
  url: "https://files.pythonhosted.org/packages/39/66/2313497fdbc7fbadf8e026c09366e3f049f9114e65ca4edc23cdb8699186/mlx_metal-0.31.1-py3-none-macosx_14_0_arm64.whl",
  sha256: "70741174131dbf7fdd479cb730e06e08c358eac3bf7905d9e884e7960cfdd5b8",
  bytes: 38_624_074,
};
const digest = (data) => createHash("sha256").update(data).digest("hex");
const run = (command, args, stdio = "inherit") =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio });
    if (child.stderr) forwardSwiftBuildDiagnostics(child.stderr, process.stderr);
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} failed (${code}) while building local speech`)),
    );
  });

if (process.platform === "darwin" && process.arch === "arm64") {
  await run(
    "xcrun",
    [
      "swift",
      "build",
      "--package-path",
      packagePath,
      "-c",
      "release",
      "--product",
      "cake-speech",
      "--force-resolved-versions",
      "--no-color-diagnostics",
    ],
    ["inherit", "inherit", "pipe"],
  );
  const release = join(packagePath, ".build", "release");
  const artifact = join(packagePath, ".build", "mlx-metal-0.31.1.whl");
  let cached;
  try {
    cached = await readFile(artifact);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!cached || cached.byteLength !== wheel.bytes || digest(cached) !== wheel.sha256) {
    const response = await fetch(wheel.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok)
      throw new Error(`MLX shader artifact download failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength !== wheel.bytes || digest(data) !== wheel.sha256)
      throw new Error("MLX shader artifact checksum mismatch");
    await writeFile(`${artifact}.tmp`, data);
    await rename(`${artifact}.tmp`, artifact);
  }
  await mkdir(output, { recursive: true });
  await cp(join(release, "cake-speech"), join(output, "cake-speech"));
  // Keep Swift runtime metadata, but don't ship the large local linker symbol table.
  await run("/usr/bin/strip", ["-x", join(output, "cake-speech")]);
  const extract = async (entry, destination) => {
    const file = await open(destination, "w");
    try {
      await run("/usr/bin/unzip", ["-p", artifact, entry], ["ignore", file.fd, "inherit"]);
    } finally {
      await file.close();
    }
  };
  await extract("mlx/lib/mlx.metallib", join(output, "mlx.metallib"));
  for (const entry of await readdir(release)) {
    if (entry.endsWith(".bundle"))
      await cp(join(release, entry), join(output, entry), { recursive: true });
  }
  const notices = join(output, "SpeechThirdPartyLicenses");
  await mkdir(notices, { recursive: true });
  const checkouts = join(packagePath, ".build", "checkouts");
  for (const checkout of await readdir(checkouts)) {
    for (const entry of await readdir(join(checkouts, checkout))) {
      if (/^licen[sc]e(?:\.[a-z]+)?$/i.test(entry))
        await cp(join(checkouts, checkout, entry), join(notices, `${checkout}-${entry}`));
    }
  }
  await extract("mlx/include/metal_cpp/LICENSE.txt", join(notices, "metal-cpp-LICENSE.txt"));
  await extract(
    "mlx_metal-0.31.1.dist-info/licenses/LICENSE",
    join(notices, "mlx-metal-LICENSE.txt"),
  );
  console.log("[cake] Bundled native MLX Pocket TTS engine and verified Metal shaders");
} else {
  for (const file of ["cake-speech", "mlx.metallib", "SpeechThirdPartyLicenses"])
    await rm(join(output, file), { recursive: true, force: true });
}
