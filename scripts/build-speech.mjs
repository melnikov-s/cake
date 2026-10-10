/* global process, console */
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { forwardSwiftBuildDiagnostics } from "./swift-build-diagnostics.mjs";
import { buildNativeBundle, swiftBuildIdentity } from "./native-build-cache.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "out", "main", "native"));
const packagePath = join(root, "native", "speech");
const run = (command, args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["inherit", "inherit", "pipe"] });
    forwardSwiftBuildDiagnostics(child.stderr, process.stderr);
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} failed (${code}) while building local speech`)),
    );
  });

if (process.platform === "darwin" && process.arch === "arm64") {
  await buildNativeBundle({
    packagePath,
    product: "cake-speech",
    output,
    inputs: [
      join(packagePath, "Sources"),
      join(packagePath, "Package.swift"),
      join(packagePath, "Package.resolved"),
      join(root, "src", "services", "speech", "pocket-tts-manifest.json"),
      fileURLToPath(import.meta.url),
      join(root, "scripts", "native-build-cache.mjs"),
      join(root, "scripts", "swift-build-diagnostics.mjs"),
    ],
    buildIdentity: await swiftBuildIdentity(),
    force: process.env.CAKE_NATIVE_REBUILD === "1",
    build: async (output) => {
      await run("xcrun", [
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
      ]);
      const release = join(packagePath, ".build", "release");
      await mkdir(output, { recursive: true });
      await cp(join(release, "cake-speech"), join(output, "cake-speech"));
      await run("/usr/bin/strip", ["-x", join(output, "cake-speech")]);
      for (const entry of await readdir(release)) {
        if (entry.endsWith(".bundle"))
          await cp(join(release, entry), join(output, entry), { recursive: true });
      }
      await cp(
        join(root, "src", "services", "speech", "pocket-tts-manifest.json"),
        join(output, "pocket-tts-manifest.json"),
      );
      const fluid = join(packagePath, ".build", "checkouts", "FluidAudio");
      const notices = join(output, "SpeechThirdPartyLicenses");
      await rm(notices, { recursive: true, force: true });
      await mkdir(notices, { recursive: true });
      await cp(join(fluid, "LICENSE"), join(notices, "FluidAudio-LICENSE.txt"));
      await cp(join(fluid, "ThirdPartyLicenses"), join(notices, "ThirdPartyLicenses"), {
        recursive: true,
      });
    },
  });
  console.log("[cake] Bundled FluidAudio/Core ML streaming Pocket TTS engine");
} else {
  for (const file of ["cake-speech", "pocket-tts-manifest.json", "SpeechThirdPartyLicenses"])
    await rm(join(output, file), { recursive: true, force: true });
}
