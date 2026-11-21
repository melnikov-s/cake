import { rm } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { dictationFixture } from "./fixtures/dictation";
import { createSessionInProject, showSessions } from "./fixtures/workspace-navigation";

for (const policy of ["protected", "disabled", "opt-out"] as const) {
  test(`session navigation respects dictation autofocus policy (${policy})`, async ({}, testInfo) => {
    test.setTimeout(60_000);
    const { root, configure, launch, sessionId } = await dictationFixture({
      dictationEnabled: policy !== "disabled",
      preventAutomaticRefocus: policy !== "opt-out",
      coldSession: true,
    });
    const evidence: unknown[] = [];
    await configure({ ready: true, speech: false, text: "" });
    const application = await launch();
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole("combobox", { name: "Message Cake Chat" })).toBeVisible();
      await page.evaluate(() => {
        performance.mark("cake.session-switch.enabled");
        const probe = { writingFocus: [] as string[], microphoneOpens: 0 };
        Reflect.set(window, "sessionNavigationFocusProbe", probe);
        document.addEventListener("focusin", (event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-slot="composer-input"]') &&
            event.target.matches('[role="combobox"]')
          ) {
            probe.writingFocus.push(event.target.getAttribute("aria-label") ?? "");
          }
        });
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (...args) => {
          probe.microphoneOpens += 1;
          return getUserMedia(...args);
        };
      });
      const composer = (name = "Message") => page.getByRole("combobox", { name, exact: true });
      const indicator = page.locator(
        '[data-slot="composer-dictation"] [data-slot="dictation-indicator"]',
      );
      const phases = () =>
        page.evaluate(
          (id) =>
            performance
              .getEntriesByName("cake.session-switch")
              .map((entry) => (entry as PerformanceMark).detail)
              .filter((detail) => detail.sessionId === id)
              .map((detail) => detail.phase as string),
          sessionId,
        );
      const snapshot = () =>
        page.evaluate(async () => {
          // Observe after the navigation's deferred focus request and the composer's focus frame.
          for (let frame = 0; frame < 3; frame += 1) await new Promise(requestAnimationFrame);
          const active = document.activeElement;
          const indicator = document.querySelector(
            '[data-slot="composer-dictation"] [data-slot="dictation-indicator"]',
          );
          const probe = Reflect.get(window, "sessionNavigationFocusProbe") as {
            writingFocus: string[];
            microphoneOpens: number;
          };
          const state = {
            active: active?.getAttribute("aria-label"),
            target: indicator?.getAttribute("data-dictation-target") ?? null,
            capture: indicator?.textContent ?? null,
            writingFocus: probe.writingFocus.slice(),
            microphoneOpens: probe.microphoneOpens,
          };
          probe.writingFocus.length = 0;
          return state;
        });
      let microphoneOpens = 0;
      const expectDestination = async (step: string, name = "Message", muted = false) => {
        await expect(composer(name)).toBeVisible();
        const parked = policy === "protected" && !muted;
        const listening = policy === "opt-out";
        if (listening) await expect(indicator).toHaveText("Listening");
        const state = await snapshot();
        evidence.push({ step, ...state });
        if (parked) {
          expect.soft(state).toMatchObject({
            active: "Press Tab to write",
            target: null,
            capture: null,
            writingFocus: [],
            microphoneOpens,
          });
        } else {
          expect.soft(state.active).toBe(name);
          expect
            .soft(state.capture)
            .toBe(muted ? "Dictation muted" : listening ? "Listening" : null);
          if (!listening) expect.soft(state.microphoneOpens).toBe(microphoneOpens);
        }
        microphoneOpens = state.microphoneOpens;
      };
      const expectExplicitCapture = async (step: string) => {
        await expect(composer()).toBeFocused();
        await expect(indicator).toHaveText("Listening");
        const state = await snapshot();
        evidence.push({ step, ...state });
        expect(state.target).toBeTruthy();
        expect(state.microphoneOpens).toBeGreaterThan(0);
        microphoneOpens = state.microphoneOpens;
      };
      const selectSaved = async (keyboard = false) => {
        const workspace = await showSessions(page);
        const button = workspace.locator(
          `[data-slot="conversation-navigator-row"][data-session-id="${sessionId}"] .session-row > button`,
        );
        await page.evaluate(() => performance.clearMarks("cake.session-switch"));
        if (keyboard) {
          await button.focus();
          await page.keyboard.press("Enter");
        } else await button.click();
        await expect(
          page.getByText("Inspect this implementation before changing it."),
        ).toBeVisible();
        await expect.poll(phases).toContain("finished");
        const marks = await phases();
        evidence.push({
          step: `saved Session via ${keyboard ? "keyboard" : "mouse"}`,
          phases: marks,
        });
        return marks;
      };
      const newDraft = () => createSessionInProject(page, /^project(?: |$)/i);

      await newDraft();
      await expectDestination("new staged Session via picker");
      expect(await selectSaved()).toContain("hydration-end");
      await expectDestination("cold saved Session via mouse");
      if (policy === "protected") {
        await composer().click();
        await expectExplicitCapture("explicit mouse focus");
      }

      const workspace = await showSessions(page);
      await workspace.getByRole("button", { name: "project", exact: true }).click();
      await expectDestination("Project Chat via Sessions row", "Message Project Chat");
      expect(await selectSaved(true)).not.toContain("hydration-start");
      await expectDestination("hydrated Session from Project Chat via keyboard");

      if (policy === "protected") {
        await page.keyboard.press("Tab");
        await expectExplicitCapture("explicit Tab focus");

        await indicator.getByRole("button", { name: "Mute dictation", exact: true }).click();
        await newDraft();
        await expectDestination("restored staged Session while muted", "Message", true);
        await selectSaved();
        await expectDestination("hydrated Session via mouse while muted", "Message", true);
      }
    } finally {
      await testInfo.attach("navigation-focus-and-capture", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
