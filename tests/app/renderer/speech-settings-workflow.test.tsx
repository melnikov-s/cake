/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsSpeechSection } from "../../../src/renderer/components/settings-speech-section";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

describe("Speech settings credentials", () => {
  it.each([false, true])(
    "shows a saved-key mask only when configured (%s), never submitting the mask",
    async (configured) => {
      const setApiKey = vi.fn<Client["speechOutput"]["setApiKey"]>(async (key) => {
        fixture.root.speechSettingsStore.applySettings({
          keyConfigured: key !== null,
          voices: [],
          modelId: "eleven_flash_v2_5",
          speed: 1,
        });
      });
      using fixture = createRendererStoreFixture({ client: { speechOutput: { setApiKey } } });
      fixture.root.speechSettingsStore.applySettings({
        keyConfigured: configured,
        voices: [],
        modelId: "eleven_flash_v2_5",
        speed: 1,
      });
      const view = render(<SettingsSpeechSection speech={fixture.root.speechSettingsStore} />);
      try {
        const user = userEvent.setup();
        const key = screen.getByLabelText<HTMLInputElement>("ElevenLabs API key");
        const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save key" });
        expect(key.type).toBe("password");
        expect(key.value).toBe("");
        expect(key.placeholder).toBe(configured ? "••••••••••••••••" : "");
        expect(save.disabled).toBe(true);
        await user.click(save);
        expect(setApiKey).not.toHaveBeenCalled();
        await user.type(key, "replacement-key");
        expect(save.disabled).toBe(false);
        await user.click(save);
        expect(setApiKey).toHaveBeenLastCalledWith("replacement-key", expect.any(Object));
        expect(key.value).toBe("");
        expect(key.placeholder).toBe("••••••••••••••••");
        expect(save.disabled).toBe(true);
        expect(JSON.stringify(toSnapshot(fixture.root))).not.toContain("replacement-key");
        await user.click(screen.getByRole("button", { name: "Remove key" }));
        expect(setApiKey).toHaveBeenLastCalledWith(null, expect.any(Object));
        expect(key.placeholder).toBe("");
        expect(screen.getByText(/No key configured/)).toBeDefined();
      } finally {
        view.unmount();
      }
    },
  );
});
