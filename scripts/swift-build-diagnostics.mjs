import { createInterface } from "node:readline";

// The pinned mlx-audio-swift manifest omits these documentation-only exclusions.
// Do not hide compiler warnings, other packages' notices, or new unhandled files.
const documentation = new Set([
  "Sources/MLXAudioTTS/Models/OmniVoice/README.md",
  "Sources/MLXAudioTTS/Models/IrodoriTTS/README.md",
  "Sources/MLXAudioTTS/Models/MossTTS/README.md",
  "Sources/MLXAudioSTS/Models/DeepFilterNet/README.md",
]);

export function forwardSwiftBuildDiagnostics(input, output) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let pending = [];
  let remaining = 0;
  const flush = () => {
    for (const line of pending) output.write(`${line}\n`);
    pending = [];
    remaining = 0;
  };
  lines.on("line", (line) => {
    if (remaining > 0) {
      if (line.startsWith("    /")) {
        pending.push(line);
        if (--remaining === 0) {
          const known = pending.slice(1).every((path) => {
            const match = path.match(/^ {4}\/.+\/checkouts\/mlx-audio-swift\/(Sources\/.+)$/);
            return match && documentation.has(match[1]);
          });
          if (known) pending = [];
          else flush();
        }
        return;
      }
      flush();
    }
    const warning = line.match(
      /^warning: 'mlx-audio-swift': found ([1-4]) file\(s\) which are unhandled; explicitly declare them as resources or exclude from the target$/,
    );
    if (warning) {
      pending = [line];
      remaining = Number(warning[1]);
    } else {
      output.write(`${line}\n`);
    }
  });
  lines.on("close", flush);
  return lines;
}
