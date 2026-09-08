import { observable, Store } from "r-state-tree";
import type { Annotation } from "../../ipc/session-contract";
import { applyAnnotationUpdate, createAnnotation } from "../../utils/annotations";

export interface AnnotationDraftStoreProps {
  annotations?: Annotation[];
  onAdded?(): void;
  onLimitReached?(): void;
}

/** Owns the mutable annotation collection for one message draft. */
export class AnnotationDraftStore extends Store<AnnotationDraftStoreProps> {
  private readonly values: Annotation[] = this.props.annotations ?? observable([]);

  get annotations(): readonly Annotation[] {
    return this.values;
  }

  add(annotation: Omit<Annotation, "id">): boolean {
    if (this.values.length >= 100) {
      this.props.onLimitReached?.();
      return false;
    }
    this.values.push(createAnnotation(crypto.randomUUID(), annotation));
    this.props.onAdded?.();
    return true;
  }

  update(id: string, update: Partial<Omit<Annotation, "id">>) {
    const index = this.values.findIndex((annotation) => annotation.id === id);
    const annotation = this.values[index];
    if (index >= 0 && annotation)
      this.values.splice(index, 1, applyAnnotationUpdate(annotation, update));
  }

  remove(id: string) {
    const index = this.values.findIndex((annotation) => annotation.id === id);
    if (index >= 0) this.values.splice(index, 1);
  }

  append(annotations: readonly Annotation[]) {
    this.values.push(...annotations);
  }

  clear() {
    this.values.splice(0);
  }
}
