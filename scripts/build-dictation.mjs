/* global process, console */
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
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
  console.log("[cake] Bundled Swift/Core ML dictation helper");
} else {
  await rm(output, { recursive: true, force: true });
}
