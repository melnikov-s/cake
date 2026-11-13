import { createStore, mount, observable, updateStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { CaptureDestination } from "../../../../src/contracts/desktop/screen-capture-data";
import { CaptureDestinationPickerStore } from "../../../../src/renderer/stores/CaptureDestinationPickerStore";
import { captureRouting } from "../../../helpers/screen-capture";

const destination: CaptureDestination = { kind: "project-session", sessionId: "session-1" };
const other: CaptureDestination = { kind: "cake-chat", sessionId: "other" };

function catalog() {
  return vi.fn(() => ({
    ...captureRouting,
    projects: [
      {
        path: "/project",
        name: "Project",
        sessions: [{ ...captureRouting.cakeChats[0]!, ...destination, title: "Initial" }],
      },
    ],
  }));
}

describe("CaptureDestinationPickerStore catalog demand", () => {
  it("does not evaluate routing during descriptor creation, mount, selection reads or explicit selection", () => {
    const routing = catalog();
    const descriptor = createStore(CaptureDestinationPickerStore, { routing });
    expect(routing).not.toHaveBeenCalled();
    using picker = mount(descriptor);
    expect(routing).not.toHaveBeenCalled();
    expect(picker.destination).toBeUndefined();
    expect(routing).not.toHaveBeenCalled();
    picker.select(destination);
    expect(picker.destination).toEqual(destination);
    expect(routing).not.toHaveBeenCalled();
    expect(picker.label).toBe("Initial");
    // label reads both chat and project routing; selectedProjectPath reads projects.
    expect(routing).toHaveBeenCalledTimes(2);
    expect(picker.selectedProjectPath).toBe("/project");
    expect(routing).toHaveBeenCalledTimes(3);
  });

  it.each([destination, undefined])(
    "captures the initial selection %j rather than following routing or prop updates",
    (initialDestination) => {
      const routing = catalog();
      using picker = mount(
        createStore(CaptureDestinationPickerStore, { routing, initialDestination }),
      );
      expect(picker.destination).toEqual(initialDestination);
      expect(routing).not.toHaveBeenCalled();
      // Updating the catalog before its first consumption must not change the
      // selection captured at materialization, even when it was undefined.
      const updatedRouting = vi.fn(() => ({ ...routing(), defaultDestination: other }));
      updateStore(picker, { routing: updatedRouting, initialDestination: other });
      expect(picker.destination).toEqual(initialDestination);
      expect(updatedRouting).not.toHaveBeenCalled();
      expect(picker.label).toBe(initialDestination ? "Initial" : "Choose destination");
      expect(updatedRouting).toHaveBeenCalledTimes(2);
      const onSelect = vi.fn();
      updateStore(picker, { onSelect });
      picker.select(destination);
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(destination);
      updateStore(picker, { routing, initialDestination: other });
      expect(picker.destination).toEqual(destination);
      expect(picker.label).toBe("Initial");
    },
  );

  it("keeps catalog updates live without replacing the captured or explicit selection", () => {
    const state = observable({ title: "Initial" });
    const routing = vi.fn(() => {
      const preferences = captureRouting;
      return {
        ...preferences,
        projects: [
          {
            path: "/project",
            name: "Project",
            sessions: [{ ...preferences.cakeChats[0]!, ...destination, title: state.title }],
          },
        ],
      };
    });
    using picker = mount(
      createStore(CaptureDestinationPickerStore, { routing, initialDestination: destination }),
    );
    expect(picker.label).toBe("Initial");
    state.title = "Renamed";
    expect(picker.label).toBe("Renamed");
    expect(picker.destination).toEqual(destination);
    picker.select(other);
    state.title = "Renamed again";
    expect(picker.label).toBe("Choose destination");
    expect(picker.destination).toEqual(other);
  });

  it("lets currentDestination override selection including undefined, without consuming routing", () => {
    const state = observable<{ current: CaptureDestination | undefined }>({ current: other });
    const routing = catalog();
    const onSelect = vi.fn();
    using picker = mount(
      createStore(CaptureDestinationPickerStore, {
        routing,
        initialDestination: destination,
        currentDestination: () => state.current,
        onSelect,
      }),
    );
    expect(picker.destination).toEqual(other);
    picker.select(destination);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(destination);
    expect(picker.destination).toEqual(other);
    state.current = undefined;
    expect(picker.destination).toBeUndefined();
    state.current = destination;
    expect(picker.destination).toEqual(destination);
    updateStore(picker, { currentDestination: undefined });
    expect(picker.destination).toEqual(destination);
    expect(routing).not.toHaveBeenCalled();
  });
});
