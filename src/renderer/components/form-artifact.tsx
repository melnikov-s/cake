import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";

export function FormArtifact({
  artifact,
  requested,
  onSubmit,
  onSkip,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "form" }>;
  requested: boolean;
  onSubmit?: (value: JsonValue) => void;
  onSkip?: () => void;
}) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const optionListId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.(values);
  };
  return (
    <form className="artifact-form" onSubmit={submit}>
      {artifact.payload.fields.map((field) => (
        <label key={field.id}>
          <span>{field.label}</span>
          {field.type === "textarea" ? (
            <textarea
              placeholder={field.placeholder}
              value={String(values[field.id] ?? "")}
              onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}
            />
          ) : field.type === "select" ? (
            <>
              <input
                type="text"
                list={`${optionListId}-${field.id}`}
                placeholder={field.placeholder ?? "Select or type…"}
                value={String(values[field.id] ?? "")}
                onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}
              />
              <datalist id={`${optionListId}-${field.id}`}>
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </datalist>
            </>
          ) : field.type === "checkbox" ? (
            <input
              type="checkbox"
              checked={Boolean(values[field.id])}
              onChange={(event) => setValues({ ...values, [field.id]: event.target.checked })}
            />
          ) : (
            <input
              type={field.type}
              placeholder={field.placeholder}
              value={String(values[field.id] ?? "")}
              onChange={(event) =>
                setValues({
                  ...values,
                  [field.id]:
                    field.type === "number" ? event.target.valueAsNumber : event.target.value,
                })
              }
            />
          )}
        </label>
      ))}
      <div className="artifact-actions">
        {requested && (
          <Button type="button" variant="outline" onClick={onSkip}>
            Skip
          </Button>
        )}
        <Button type="submit">{artifact.payload.submitLabel}</Button>
      </div>
    </form>
  );
}
