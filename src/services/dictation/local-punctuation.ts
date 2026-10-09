import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { Schema } from "effect";
import { punctuationWords, type PunctuationWord } from "../../utils/punctuation-text";
import type { PunctuationResult } from "../../domain/dictation/dictation-data";
import manifest from "./punctuation-manifest.json";
import tokenizerData from "./punctuation-tokenizer.json";
import type { InstallProgress } from "./local-parakeet";

const vocabulary = Schema.decodeUnknownSync(
  Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
)(tokenizerData.model.vocab);
const WINDOW = 254;
const OVERLAP = 32;
const PUNCTUATION = ["", "", ".", ",", "?"];

const punctuationModelPath = (root: string) => join(root, "model", manifest.file);
export async function punctuationInstalled(root: string): Promise<boolean> {
  try {
    return (await stat(punctuationModelPath(root))).size === manifest.bytes;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Explicit, pinned data download; installed users never need Python or conversion tools. */
export async function installPunctuation(
  root: string,
  signal: AbortSignal,
  progress: (value: InstallProgress) => void,
) {
  const staging = join(root, "model.download");
  const destination = join(staging, manifest.file);
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  try {
    const response = await fetch(
      `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${manifest.file}`,
      { signal },
    );
    if (!response.ok || !response.body)
      throw new Error(`Punctuation download failed: HTTP ${response.status}`);
    const handle = await open(destination, "w");
    const digest = createHash("sha256");
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        bytes += value.length;
        if (bytes > manifest.bytes) throw new Error("Unexpected punctuation model size");
        digest.update(value);
        let offset = 0;
        while (offset < value.length) offset += (await handle.write(value, offset)).bytesWritten;
        progress({
          message: "Downloading local punctuation…",
          downloadedBytes: bytes,
          totalBytes: manifest.bytes,
        });
      }
      if (bytes !== manifest.bytes || digest.digest("hex") !== manifest.sha256)
        throw new Error("Punctuation model checksum mismatch. Please retry.");
    } finally {
      await reader.cancel();
      await handle.close();
    }
    await writeFile(
      join(staging, "ATTRIBUTION.txt"),
      `English punctuation, capitalization and sentence boundaries by 1-800-BAD-CODE.\nhttps://huggingface.co/${manifest.repository}\nRevision: ${manifest.revision}\nLicense: Apache-2.0\nhttps://www.apache.org/licenses/LICENSE-2.0\nTokenizer exported from the pinned SentencePiece vocabulary; original SHA-256: ${manifest.tokenizerSha256}\n`,
    );
    await writeFile(join(staging, "LICENSE.txt"), tokenizerData.license);
    signal.throwIfAborted();
    // Inference/install/remove are serialized by the owning Service. Existing complete weights
    // remain untouched on download failure; rename of the verified file is the publication point.
    await mkdir(join(root, "model"), { recursive: true });
    await rename(destination, punctuationModelPath(root));
    await rename(join(staging, "ATTRIBUTION.txt"), join(root, "model", "ATTRIBUTION.txt"));
    await rename(join(staging, "LICENSE.txt"), join(root, "model", "LICENSE.txt"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

interface PunctuationPrediction {
  readonly after: readonly number[];
  readonly capitalize: readonly boolean[];
}
type PunctuationPredictor = (ids: readonly number[]) => Promise<PunctuationPrediction>;

/** Labels are applied to original words. Unknown vocabulary pieces can never replace characters. */
export class PunctuationEngine {
  private readonly tokenizer = new Tokenizer(tokenizerData, { unk_token: "<Unk>" });
  // One insertion's ephemeral streaming context, not a persisted transcript or keyed cache.
  // The Service serializes calls; focus/manual-edit generations supply a fresh utterance ID.
  private previous: { id: string; words: PunctuationWord[]; rendered: string[] } | undefined;
  constructor(private readonly predict: PunctuationPredictor) {}

  async punctuate(
    text: string,
    final: boolean,
    signal: AbortSignal,
    utteranceId: string,
  ): Promise<PunctuationResult> {
    signal.throwIfAborted();
    const words = punctuationWords(text);
    if (!words.length) return { text: "", pendingStart: 0 };
    const previous = this.previous?.id === utteranceId ? this.previous : undefined;
    let common = 0;
    while (
      previous &&
      common < words.length &&
      common < previous.words.length &&
      words[common]!.text === previous.words[common]!.text &&
      words[common]!.before === previous.words[common]!.before &&
      words[common]!.protected === previous.words[common]!.protected
    )
      common++;
    // Revisit a recent passage, including overlap, rather than re-running a growing draft.
    // An ASR correction to older words deliberately reopens the affected suffix.
    const startWord = Math.min(common, Math.max(0, words.length - 96));
    // Earlier settled words are context only: do not expose capitalization guesses caused by
    // the artificial beginning of this rolling window in the middle of a sentence.
    const contextWord = Math.max(0, startWord - 16);
    const ids: number[] = [];
    const spans = words.map((word, index) => {
      const start = ids.length;
      if (index < contextWord) return { start, end: start };
      ids.push(
        ...this.tokenizer.encode(word.text.toLowerCase(), { add_special_tokens: false }).ids,
      );
      return { start, end: ids.length };
    });
    const labels: Array<{ after: number; capitalize: boolean } | undefined> = [];
    for (let start = 0; start < ids.length; start += WINDOW - OVERLAP) {
      signal.throwIfAborted();
      const stop = Math.min(ids.length, start + WINDOW);
      const output = await this.predict([1, ...ids.slice(start, stop), 2]);
      signal.throwIfAborted();
      const left = start === 0 ? start : start + OVERLAP / 2;
      const right = stop === ids.length ? stop : stop - OVERLAP / 2;
      for (let index = left; index < right; index++)
        labels[index] = {
          after: output.after[index - start + 1] ?? 0,
          capitalize: output.capitalize[index - start + 1] ?? false,
        };
      if (stop === ids.length) break;
    }
    let result = "";
    const rendered: string[] = [];
    let pendingStart = 0;
    const pendingWord = final ? words.length : Math.max(0, words.length - 4);
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!;
      const span = spans[index]!;
      result += index === 0 ? "" : word.before;
      if (index === pendingWord) pendingStart = result.length;
      if (index < startWord && previous) {
        rendered.push(previous.rendered[index]!);
        result += previous.rendered[index]!;
        continue;
      }
      let source = word.text;
      if (!word.protected && source) {
        const first = labels[span.start];
        // Only change the initial letter: preserve internal casing, acronyms and identifiers.
        source = source.replace(
          /^(["'“‘]*)(\p{L})/u,
          (_, prefix: string, letter: string) =>
            prefix + (first?.capitalize ? letter.toUpperCase() : letter.toLowerCase()),
        );
      }
      const punctuation = PUNCTUATION[labels[span.end - 1]?.after ?? 0] ?? "";
      // The model otherwise punctuates every incomplete final fragment as a finished sentence.
      if (
        (final || index < words.length - 1) &&
        !/[.!?,;:]$/u.test(source) &&
        !word.protected &&
        !source.endsWith("`") &&
        punctuation
      )
        source += punctuation;
      rendered.push(source);
      result += source;
    }
    this.previous = { id: utteranceId, words, rendered };
    return { text: result, pendingStart: final ? result.length : pendingStart };
  }
}

/** Main-only native CPU session, warm until release. No transcript or audio persistence. */
export async function loadPunctuationEngine(root: string) {
  // Verify an installed file before loading its graph. Installation already verifies once, but
  // users can alter private files; do not feed an unchecked graph to the native runtime.
  const bytes = await readFile(punctuationModelPath(root));
  if (
    bytes.length !== manifest.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
  )
    throw new Error("Local punctuation weights are missing or damaged. Download the model again.");
  const { InferenceSession, Tensor } = await import("onnxruntime-node");
  const session = await InferenceSession.create(bytes, {
    executionProviders: ["cpu"],
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  });
  const engine = new PunctuationEngine(async (ids) => {
    const output = await session.run({
      input_ids: new Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    });
    const post = output.post_preds,
      cap = output.cap_preds;
    if (
      !post ||
      !cap ||
      post.dims[1] !== ids.length ||
      cap.dims[1] !== ids.length ||
      cap.dims.length !== 3
    )
      throw new Error("Invalid punctuation model output");
    const width = cap.dims[2]!;
    return {
      after: Array.from(post.data, Number),
      // SentencePiece's leading whitespace marker occupies capitalization slot zero.
      capitalize: ids.map((id, index) => {
        const leadingSpace = vocabulary[id]?.[0].startsWith("▁") ?? false;
        return !!cap.data[index * width + (leadingSpace ? 1 : 0)];
      }),
    };
  });
  return { engine, close: () => session.release() };
}
