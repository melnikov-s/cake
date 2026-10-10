import type { InterviewField } from "../../contracts/interviews/interview";

export type InterviewFormValue = string | number | boolean;

export function listedOptions(field: InterviewField) {
  return field.options?.filter(
    (option) =>
      option.value.trim().toLowerCase() !== "other" &&
      option.label
        .trim()
        .toLowerCase()
        .replace(/(?:\.{3}|…)$/, "") !== "other",
  );
}
