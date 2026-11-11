/** @vitest-environment jsdom */
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchableChoiceDialog } from "../../../src/renderer/components/ui/searchable-choice-dialog";

afterEach(cleanup);

const choices = Array.from({ length: 125 }, (_, index) => ({
  id: String(index),
  label: `Choice ${index}`,
}));

describe("Searchable choice dialog presentation", () => {
  it("keeps the selected description readable as the active row changes", () => {
    render(
      <SearchableChoiceDialog
        title="Choose"
        searchLabel="Search choices"
        choices={() => [
          { id: "first", label: "First", description: "First description" },
          { id: "second", label: "Second", description: "Second description" },
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const first = screen.getByText("First description");
    const second = screen.getByText("Second description");
    expect(first.classList.contains("text-foreground")).toBe(true);
    expect(second.classList.contains("text-muted-foreground")).toBe(true);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(first.classList.contains("text-muted-foreground")).toBe(true);
    expect(second.classList.contains("text-foreground")).toBe(true);
  });
  it("sizes to its results unless the caller opts into a stable frame", () => {
    const view = render(
      <SearchableChoiceDialog
        title="Choose"
        searchLabel="Search choices"
        choices={() => choices.slice(0, 3)}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const content = () => screen.getByRole("dialog").firstElementChild!;
    expect(content().className).not.toContain("h-[min(");
    expect(screen.getByRole("listbox").className).toContain("max-h-72");
    view.rerender(
      <SearchableChoiceDialog
        title="Choose"
        searchLabel="Search choices"
        choices={() => choices.slice(0, 3)}
        stableHeight
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(content().className).toContain("h-[min(28rem,75vh)]");
    expect(screen.getByRole("listbox").className).toContain("min-h-0");
    expect(screen.getByRole("listbox").className).not.toContain("max-h-72");
  });
  it("keeps urgent draft updates out of the results render and prevents selecting stale results", async () => {
    let ready = false;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const select = vi.fn();
    const filter = vi.fn((query: string) => {
      if (query && !ready) throw pending;
      return query ? [choices[1]!] : [choices[0]!];
    });
    render(
      <Suspense fallback={<p>Loading results</p>}>
        <SearchableChoiceDialog
          title="Choose"
          description="Pick a choice"
          searchLabel="Search choices"
          choices={filter}
          onSelect={select}
          onClose={() => {}}
        />
      </Suspense>,
    );
    const initialRenders = filter.mock.calls.filter(([query]) => query === "").length;
    const input = screen.getByRole<HTMLInputElement>("combobox");
    fireEvent.change(input, { target: { value: "new" } });
    expect(input.value).toBe("new");
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("option").textContent).toBe("Choice 0");
    expect(screen.queryByText("Loading results")).toBeNull();
    expect(filter.mock.calls.filter(([query]) => query === "")).toHaveLength(initialRenders);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "newest" } });
    expect(input.value).toBe("newest");
    await act(async () => {
      ready = true;
      finish();
      await pending;
    });
    await waitFor(() => expect(screen.getByRole("option").textContent).toBe("Choice 1"));
    expect(input.value).toBe("newest");
    expect(input.getAttribute("aria-busy")).toBe("false");
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("1");
  });

  it("queues a fast Enter until the current draft has results", async () => {
    let ready = false;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const select = vi.fn();
    render(
      <Suspense fallback={<p>Loading results</p>}>
        <SearchableChoiceDialog
          title="Choose"
          description="Pick a choice"
          searchLabel="Search choices"
          choices={(query) => {
            if (query && !ready) throw pending;
            return [query ? choices[1]! : choices[0]!];
          }}
          onSelect={select}
          onClose={() => {}}
        />
      </Suspense>,
    );
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).not.toHaveBeenCalled();
    await act(async () => {
      ready = true;
      finish();
      await pending;
    });
    await waitFor(() => expect(select).toHaveBeenCalledWith("1"));
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("bounds mounted rows while all matches remain reachable by paging and keyboard", () => {
    const select = vi.fn();
    const filter = vi.fn(() => choices);
    render(
      <SearchableChoiceDialog
        title="Choose"
        description="Pick a choice"
        searchLabel="Search choices"
        choices={filter}
        onSelect={select}
        onClose={() => {}}
      />,
    );
    const input = screen.getByRole("combobox");
    expect(screen.getAllByRole("option")).toHaveLength(25);
    expect(screen.getByText("1–25 of 125")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Next results" }));
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("Choice 25");
    expect(screen.getAllByRole("option")).toHaveLength(25);
    expect(screen.getByText("26–50 of 125")).toBeDefined();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("Choice 24");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("Choice 25");
    fireEvent.click(screen.getByRole("button", { name: "Previous results" }));
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const last = screen.getByRole("option", { selected: true });
    expect(last.textContent).toBe("Choice 124");
    expect(input.getAttribute("aria-activedescendant")).toBe(last.id);
    expect(screen.getAllByRole("option")).toHaveLength(25);
    expect(screen.getByText("101–125 of 125")).toBeDefined();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(select).toHaveBeenCalledWith("124");
    expect(filter).toHaveBeenCalledTimes(1);
  });
});
