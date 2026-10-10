import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { SpeechOutputAudio } from "../../contracts/speech/speech-output-data";

const Reply = Schema.Union([
  Schema.Struct({ ready: Schema.Literal(true) }),
  Schema.Struct({ pcm: SpeechOutputAudio.fields.pcm }),
  Schema.Struct({ done: Schema.Literal(true) }),
  Schema.Struct({ error: Schema.String }),
]);

/** One request at a time, enforced by the owning Service. No shell, Python or runtime download.
 * Cancellation kills the process instead of leaving a queued/background generation running.
 */
export class PocketTtsWorker {
  private readonly process: ChildProcessWithoutNullStreams;
  private pending:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
        audio: ((audio: SpeechOutputAudio) => void) | undefined;
        received: boolean;
      }
    | undefined;
  private failed: Error | undefined;
  readonly ready: Promise<void>;

  constructor(executable: string, modelPath: string) {
    this.process = spawn(
      executable,
      [modelPath, join(dirname(executable), "pocket-tts-manifest.json")],
      { stdio: "pipe" },
    );
    this.ready = this.response();
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 87_500) throw new Error("Oversized local speech response");
        const reply = Schema.decodeUnknownSync(Reply)(JSON.parse(line));
        const pending = this.pending;
        if (!pending) throw new Error("Unexpected local speech response");
        if ("error" in reply)
          throw new Error("Local speech generation failed. Re-enter voice mode to retry.");
        if ("pcm" in reply) {
          if (!pending.audio) throw new Error("Unexpected local speech audio");
          const bytes = Buffer.from(reply.pcm, "base64");
          if (
            !bytes.length ||
            bytes.length > 65_536 ||
            bytes.length % 2 ||
            bytes.toString("base64") !== reply.pcm
          )
            throw new Error("Invalid local speech PCM");
          pending.received = true;
          pending.audio({ encoding: "pcm_s16le", sampleRate: 24_000, pcm: reply.pcm });
        } else {
          if (
            "ready" in reply === (pending.audio !== undefined) ||
            (pending.audio && !pending.received)
          )
            throw new Error("Invalid local speech completion");
          this.pending = undefined;
          pending.resolve();
        }
      } catch {
        this.close();
      }
    });
    // Do not retain native diagnostics: upstream messages can contain paths or spoken text.
    this.process.stderr.resume();
    this.process.stdin.on("error", () => this.close());
    this.process.once("error", () => this.close());
    this.process.once("exit", () => {
      lines.close();
      this.close();
    });
  }

  private response(audio?: (audio: SpeechOutputAudio) => void): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.close(), 180_000);
      this.pending = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        audio,
        received: false,
      };
    });
  }

  async synthesize(
    text: string,
    speed: number,
    signal: AbortSignal,
    audio: (audio: SpeechOutputAudio) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const cancel = () => this.close();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const done = this.response(audio);
      this.process.stdin.write(`${JSON.stringify({ text, voice: "alba", speed })}\n`);
      await done;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  close(): void {
    this.failed ??= new Error("The local speech engine stopped. Re-enter voice mode to reload it.");
    this.pending?.reject(this.failed);
    this.pending = undefined;
    this.process.kill("SIGKILL");
  }
}
