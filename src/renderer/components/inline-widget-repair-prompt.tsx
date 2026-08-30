import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
    <form className="border-b border-border bg-muted/30 p-3" onSubmit={submit}>
      <label className="block space-y-1.5">
        <span className="block text-xs font-medium text-foreground">What should be repaired?</span>
        <Textarea
          autoFocus
          required
          rows={3}
          placeholder="Describe the problem or change you want…"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!instructions.trim()}>
          Submit
        </Button>
      </div>
    </form>
  );
}
