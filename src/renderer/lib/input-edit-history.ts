export interface InputSelection {
  value: string;
  start: number;
  end: number;
  direction?: "forward" | "backward" | "none";
}

interface Edit {
  before: InputSelection;
  after: InputSelection;
  kind: string;
  group?: symbol;
  time: number;
}

/** Ephemeral text/selection history for edits that cannot live in Chromium's undo stack. */
export class InputEditHistory {
  private past: Edit[] = [];
  private future: Edit[] = [];
  private grouping = false;
  current: InputSelection;

  constructor(initial: InputSelection) {
    this.current = initial;
  }

  reset(value: InputSelection) {
    this.past = [];
    this.future = [];
    this.current = value;
    this.grouping = false;
  }

  select(value: InputSelection) {
    if (value.value !== this.current.value) return;
    if (value.start !== this.current.start || value.end !== this.current.end) this.grouping = false;
    this.current = value;
  }

  record(
    before: InputSelection,
    after: InputSelection,
    kind: string,
    time: number,
    group?: symbol,
  ) {
    this.current = after;
    if (before.value === after.value) return;
    const last = this.past.at(-1);
    const continuous =
      last &&
      last.after.value === before.value &&
      (group
        ? last.group === group
        : this.grouping &&
          !last.group &&
          last.kind === kind &&
          /^(insertText|deleteContentBackward|deleteContentForward)$/.test(kind) &&
          time - last.time < 1000 &&
          before.start === before.end &&
          last.after.start === before.start &&
          last.after.end === before.end);
    if (continuous) {
      last.after = after;
      last.time = time;
      // A cancelled provisional edit is not an undo step.
      if (last.before.value === after.value) this.past.pop();
    } else {
      this.past.push({ before, after, kind, time, group });
      if (this.past.length > 200) this.past.shift();
    }
    this.future = [];
    this.grouping = true;
  }

  undo() {
    this.grouping = false;
    const edit = this.past.pop();
    if (!edit) return;
    this.future.push(edit);
    return (this.current = edit.before);
  }

  redo() {
    this.grouping = false;
    const edit = this.future.pop();
    if (!edit) return;
    this.past.push(edit);
    return (this.current = edit.after);
  }
}
