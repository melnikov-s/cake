import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Select } from "../ui/select";

export const AutomationContextField = observer(function AutomationContextField() {
  const root = useStore(RootStore);
  const editor = root.automationsStore.editor;
  const context = editor.definition?.context;
  if (!context) return null;
  return (
    <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
      <span className="text-muted-foreground">Context</span>
      <Select
        aria-label="Execution context"
        value={context._tag === "Global" ? "global" : context.projectPath}
        onChange={(event) =>
          editor.setContext(
            event.currentTarget.value === "global"
              ? { _tag: "Global" }
              : { _tag: "Project", projectPath: event.currentTarget.value },
          )
        }
      >
        <option value="global">Global</option>
        {root.projectCatalogStore.projects.map((project) => (
          <option key={project.path} value={project.path}>
            {project.name}
          </option>
        ))}
      </Select>
    </label>
  );
});
