import { once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { forwardSwiftBuildDiagnostics } from "../../scripts/swift-build-diagnostics.mjs";

const warning = (count: number, dependency = "mlx-audio-swift") =>
  `warning: '${dependency}': found ${count} file(s) which are unhandled; explicitly declare them as resources or exclude from the target`;
const path = (file: string) => `    /work/native/speech/.build/checkouts/mlx-audio-swift/${file}`;
const tts = [
  path("Sources/MLXAudioTTS/Models/OmniVoice/README.md"),
  path("Sources/MLXAudioTTS/Models/IrodoriTTS/README.md"),
  path("Sources/MLXAudioTTS/Models/MossTTS/README.md"),
];
const sts = path("Sources/MLXAudioSTS/Models/DeepFilterNet/README.md");

async function forward(source: string, chunkSize = source.length) {
  const input = new PassThrough();
  const output = new PassThrough();
  let result = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    result += chunk;
  });
  const lines = forwardSwiftBuildDiagnostics(input, output);
  const closed = once(lines, "close");
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    input.write(source.slice(offset, offset + chunkSize));
  }
  input.end();
  await closed;
  return result;
}

test.each([1, 7, 4096])(
  "omits only known documentation notices across %i-byte chunks",
  async (size) => {
    const source = [
      "Planning build",
      warning(3),
      ...tts,
      warning(1),
      sts,
      "warning: cake-speech: compiler warning",
      "error: build failed",
      "",
    ].join("\n");
    expect(await forward(source, size)).toBe(
      "Planning build\nwarning: cake-speech: compiler warning\nerror: build failed\n",
    );
  },
);

test.each([
  [warning(2), tts[0], path("Sources/MLXAudioTTS/new-resource.json")],
  [warning(1), path("Sources/MLXAudioTTS/Models/NewModel/README.md")],
  [warning(1, "another-package"), sts],
  [
    warning(1),
    "    /work/checkouts/another-package/Sources/MLXAudioSTS/Models/DeepFilterNet/README.md",
  ],
  [warning(3), tts[0]],
  [warning(5), ...tts, sts, path("Sources/MLXAudioTTS/new-resource.json")],
])("preserves unknown, mixed, other-package, and incomplete diagnostics: %j", async (...lines) => {
  const source = `${lines.join("\n")}\n`;
  expect(await forward(source, 7)).toBe(source);
});

test("preserves interrupted notices and resumes filtering at the next diagnostic", async () => {
  const incomplete = `${warning(3)}\n${tts[0]}\nerror: interrupted build\n`;
  expect(await forward(`${incomplete}${warning(1)}\n${sts}\n`, 7)).toBe(incomplete);
});

test("flushes an incomplete final diagnostic without a trailing newline", async () => {
  const source = `${warning(3)}\n${tts[0]}`;
  expect(await forward(source)).toBe(`${source}\n`);
});
