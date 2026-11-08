import type { ProjectSettings } from "../../contracts/application/application-data";
import { RadioGroup } from "./ui/radio-group";

/** The same direct-merge permission choice in Add project and Project Settings. */
export function ProjectMergeWorkflowField({
  value,
  onChange,
  disabled,
}: {
  value: ProjectSettings["worktreeLanding"];
  onChange(value: ProjectSettings["worktreeLanding"]): void;
  disabled?: boolean;
}) {
  return (
    <section className="grid gap-1.5">
      <RadioGroup
        label="Merge workflow"
        variant="cards"
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        options={[
          {
            value: "merge",
            label: "Merge with Cake",
            description:
              "Allow Cake to merge work into the project’s target branch. Manual merging is still available.",
          },
          {
            value: "pull-request",
            label: "Merge outside Cake",
            description:
              "Use pull requests, reviews, CI, or a merge queue outside Cake. Cake won’t offer direct merge actions.",
          },
        ]}
      />
      <p className="px-0.5 text-xs text-muted-foreground">
        This controls access to direct merging, not automatic merging.
      </p>
    </section>
  );
}
