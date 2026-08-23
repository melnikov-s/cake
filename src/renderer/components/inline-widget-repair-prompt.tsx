import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

export function InlineWidgetRepairPrompt({
  onCancel,
  onSubmit,
}: {
  onCancel(): void;
  onSubmit(instructions: string): void;
}) {
  const [instructions, setInstructions] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = instructions.trim();
    if (value) onSubmit(value);
  };
  return (
    <form className="inline-widget-repair-form" onSubmit={submit}>
      <label>
        <span>What should be repaired?</span>
        <textarea
          autoFocus
          required
          rows={3}
          placeholder="Describe the problem or change you want…"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <div className="inline-widget-repair-actions">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!instructions.trim()}>
          Submit
        </Button>
      </div>
    </form>
  );
}
