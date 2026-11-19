import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { LabelPicker } from "./ui/label-picker";

export const ProjectTodoLabelPicker = observer(function ProjectTodoLabelPicker({
  item,
  store,
  className,
  disabled,
  notifyOnError,
  showName,
  unlabelledClassName,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
  className?: string;
  disabled?: boolean;
  notifyOnError?: boolean;
  showName?: boolean;
  unlabelledClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const { labelId, labels, inheritedLabels } = store.labelPickerState(item, open);
  return (
    <LabelPicker
      open={open}
      onOpenChange={setOpen}
      labelId={labelId}
      labels={labels}
      inheritedLabels={inheritedLabels}
      ariaLabel={`Change label for ${item.title}`}
      disabled={disabled || store.busy}
      className={className}
      showName={showName}
      unlabelledClassName={unlabelledClassName}
      onChange={(labelId) => store.setLabel(item, labelId, { notifyOnError })}
    />
  );
});
