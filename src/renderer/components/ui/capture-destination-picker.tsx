import type {
  CaptureDestination,
  CaptureRouting,
} from "../../../services/electron/screen-capture-data";
import { Select } from "./select";

/** Grouped attachment routing. New session stays first; its Project is chosen explicitly. */
export function CaptureDestinationPicker({
  routing,
  destination,
  newSessionProjectPath,
  disabled,
  onChange,
}: {
  routing: CaptureRouting;
  destination: CaptureDestination;
  newSessionProjectPath: string;
  disabled: boolean;
  onChange(destination: CaptureDestination): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Attach to</span>
      <Select
        aria-label="Screenshot destination"
        className="w-56"
        disabled={disabled}
        value={destination.kind === "new-session" ? "new" : destination.sessionId}
        onChange={(event) => {
          const sessionId = event.target.value;
          if (sessionId === "new") {
            onChange({ kind: "new-session", projectPath: newSessionProjectPath });
          } else {
            onChange({
              kind: routing.cakeChats.some((session) => session.sessionId === sessionId)
                ? "cake-chat"
                : "project-session",
              sessionId,
            });
          }
        }}
      >
        <option value="new" disabled={routing.projects.length === 0}>
          New session
        </option>
        {routing.projects.map((project) => (
          <optgroup key={project.path} label={project.name}>
            {project.sessions.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {session.title || "Untitled session"}
              </option>
            ))}
          </optgroup>
        ))}
        {routing.cakeChats.length > 0 && (
          <optgroup label="Cake Chat">
            {routing.cakeChats.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {session.title || "Untitled chat"}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      {destination.kind === "new-session" && (
        <Select
          aria-label="New session Project"
          className="w-44"
          disabled={disabled}
          value={destination.projectPath}
          onChange={(event) => onChange({ kind: "new-session", projectPath: event.target.value })}
        >
          {routing.projects.map((project) => (
            <option key={project.path} value={project.path}>
              {project.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
