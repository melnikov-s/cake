/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechOutputSettings } from "../../../src/domain/speech/speech-output-data";
import { SettingsSpeechSection } from "../../../src/renderer/components/settings-speech-section";
import { pocketTtsState, speechOutputSettings } from "../../helpers/speech-output";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

function fixture(supported = true) {
  let authority = speechOutputSettings({
    keyConfigured: true,
    voiceId: "cloud-voice",
    speed: 1.1,
    voices: [{ id: "cloud-voice", name: "Saved cloud voice" }],
    localModel: pocketTtsState({ supported }),
  });
  let cloud = authority;
  let download: { signal: AbortSignal; finish: () => void } | undefined;
  const cancelled = vi.fn();
  const publish = (next: SpeechOutputSettings) => {
    authority = next;
    root.speechSettingsStore.applySettings(next);
  };
  const installLocal = vi.fn(async (options?: { signal?: AbortSignal }) => {
    if (!options?.signal) throw new Error("Missing cancellation signal");
    const signal = options.signal;
    publish({
      ...authority,
      localModel: { ...authority.localModel, installing: true, downloadedBytes: 50_000_000 },
    });
    await new Promise<void>((resolve, reject) => {
      download = { signal, finish: resolve };
      signal.addEventListener(
        "abort",
        () => {
          cancelled();
          publish({
            ...authority,
            localModel: { ...authority.localModel, installing: false, installed: false },
          });
          reject(new Error("Cancelled"));
        },
        { once: true },
      );
    });
    publish({
      ...authority,
      localModel: {
        ...authority.localModel,
        installing: false,
        installed: true,
        downloadedBytes: authority.localModel.totalBytes,
      },
    });
  });
  const setProvider = vi.fn(async (provider: "elevenlabs" | "pocket-tts") => {
    const localModel = { ...authority.localModel, selected: provider === "pocket-tts" };
    publish(
      provider === "pocket-tts"
        ? {
            ...authority,
            provider,
            modelId: "pocket-tts-coreml",
            voiceId: "alba",
            speed: localModel.speed,
            voices: [{ id: "alba", name: "Alba" }],
            localModel,
          }
        : { ...cloud, localModel },
    );
  });
  const setSpeed = vi.fn(async (speed: number) => {
    if (authority.provider === "pocket-tts")
      publish({ ...authority, speed, localModel: { ...authority.localModel, speed } });
    else {
      cloud = { ...cloud, speed };
      publish({ ...authority, speed });
    }
  });
  const removeLocal = vi.fn(async () =>
    publish({
      ...authority,
      localModel: { ...authority.localModel, installed: false, downloadedBytes: 0 },
    }),
  );
  const rootFixture = createRendererStoreFixture({
    client: { speechOutput: { setProvider, setSpeed, installLocal, removeLocal } },
  });
  const { root } = rootFixture;
  root.speechSettingsStore.applySettings(authority);
  const view = render(<SettingsSpeechSection speech={root.speechSettingsStore} />);
  const user = userEvent.setup();
  return {
    root,
    user,
    setProvider,
    setSpeed,
    installLocal,
    removeLocal,
    cancelled,
    finishDownload() {
      if (!download) throw new Error("No active download");
      download.finish();
    },
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

describe("local speech settings", () => {
  it("selects one local model, downloads it with progress, removes it, and preserves cloud preferences", async () => {
    using f = fixture();
    expect(f.installLocal).not.toHaveBeenCalled();
    await f.user.selectOptions(screen.getByLabelText("Speech provider"), "pocket-tts");
    const download = await screen.findByRole("button", { name: "Download Pocket TTS · 370 MB" });
    expect(screen.getByText(/no Python or API key/)).toBeDefined();
    expect((screen.getByRole("slider", { name: "Speaking speed" }) as HTMLInputElement).value).toBe(
      "1",
    );
    await f.user.click(download);
    await screen.findByText("Downloading Pocket TTS… 50.0 / 370 MB");
    expect(f.installLocal).toHaveBeenCalledTimes(1);
    await act(async () => f.finishDownload());
    await screen.findByText("Pocket TTS is installed and ready for voice mode.");
    await f.user.selectOptions(screen.getByLabelText("Speech provider"), "elevenlabs");
    await screen.findByText("Saved cloud voice");
    expect((screen.getByLabelText("Voice") as HTMLSelectElement).value).toBe("cloud-voice");
    expect(screen.getByText("1.10×")).toBeDefined();
    await f.user.selectOptions(screen.getByLabelText("Speech provider"), "pocket-tts");
    await f.user.click(await screen.findByRole("button", { name: "Remove local model" }));
    await screen.findByRole("button", { name: "Download Pocket TTS · 370 MB" });
    expect(f.removeLocal).toHaveBeenCalledTimes(1);
  });

  it("remembers distinct provider speeds and clears an uncommitted draft on provider changes", async () => {
    using f = fixture();
    const provider = screen.getByLabelText("Speech provider");
    const slider = screen.getByRole("slider", { name: "Speaking speed" }) as HTMLInputElement;
    expect(slider.max).toBe("1.2");
    await f.user.selectOptions(provider, "pocket-tts");
    expect(slider.max).toBe("2");
    fireEvent.change(slider, { target: { value: "1.75" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(f.setSpeed).toHaveBeenCalledWith(1.75, expect.any(Object)));
    await f.user.selectOptions(provider, "elevenlabs");
    expect(slider.value).toBe("1.1");
    expect(slider.max).toBe("1.2");
    fireEvent.change(slider, { target: { value: "1.2" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(f.setSpeed).toHaveBeenCalledWith(1.2, expect.any(Object)));
    await f.user.selectOptions(provider, "pocket-tts");
    expect(slider.value).toBe("1.75");
    fireEvent.change(slider, { target: { value: "2" } });
    await f.user.selectOptions(provider, "elevenlabs");
    expect(slider.value).toBe("1.2");
    await f.user.selectOptions(provider, "pocket-tts");
    expect(slider.value).toBe("1.75");
  });

  it("cancels an explicit download, retains no installed state, and allows a clean retry", async () => {
    using f = fixture();
    await f.user.selectOptions(screen.getByLabelText("Speech provider"), "pocket-tts");
    await f.user.click(await screen.findByRole("button", { name: /Download Pocket TTS/ }));
    await f.user.click(await screen.findByRole("button", { name: "Cancel download" }));
    await screen.findByRole("button", { name: /Download Pocket TTS/ });
    expect(f.cancelled).toHaveBeenCalledTimes(1);
    await f.user.click(screen.getByRole("button", { name: /Download Pocket TTS/ }));
    await act(async () => f.finishDownload());
    await screen.findByText("Pocket TTS is installed and ready for voice mode.");
    expect(f.installLocal).toHaveBeenCalledTimes(2);
  });

  it("keeps cloud speech usable on platforms that cannot run local Pocket TTS", async () => {
    using f = fixture(false);
    expect(
      (screen.getByRole("option", { name: "Pocket TTS · local" }) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Local output requires Apple Silicon/)).toBeDefined();
    expect(screen.getByLabelText("ElevenLabs API key")).toBeDefined();
    expect(f.setProvider).not.toHaveBeenCalled();
  });

  it("disposal cancels a pending model download", async () => {
    const f = fixture();
    await f.user.selectOptions(screen.getByLabelText("Speech provider"), "pocket-tts");
    await f.user.click(await screen.findByRole("button", { name: /Download Pocket TTS/ }));
    f[Symbol.dispose]();
    await waitFor(() => expect(f.cancelled).toHaveBeenCalledTimes(1));
  });
});
