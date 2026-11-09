/** Navigation shortcuts can run before document-level popover event handlers. */
export const annotationDismissalEvent = "cake-annotation-dismissal";
export function requestAnnotationDismissal(): boolean {
  return !window.dispatchEvent(new Event(annotationDismissalEvent, { cancelable: true }));
}
