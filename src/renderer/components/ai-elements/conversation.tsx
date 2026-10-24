/*
 * Inspired by Vercel AI Elements conversation.tsx at
 * 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0).
 * Modified by Cake to remove AI SDK contracts and add a virtualized transcript primitive.
 */
import {
  forwardRef,
  useState,
  type ComponentProps,
  type ForwardedRef,
  type Key,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from "react";
import {
  Virtuoso,
  type FollowOutput,
  type IndexLocationWithAlign,
  type VirtuosoHandle,
  type VirtuosoProps,
} from "react-virtuoso";
import { cn } from "@/lib/utils";

export function Conversation({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-5 overflow-x-hidden",
        className,
      )}
      aria-label="Conversation"
      {...props}
    />
  );
}

export type VirtualizedConversationHandle = VirtuosoHandle;

export interface VirtualizedConversationProps<Item, Context = unknown> {
  context?: Context;
  className?: string;
  data: readonly Item[];
  computeItemKey: (index: number, item: Item) => Key;
  itemContent: (index: number, item: Item) => ReactNode;
  components?: VirtuosoProps<Item, Context>["components"];
  customScrollParent?: HTMLElement;
  followOutput?: FollowOutput;
  /** The consumer owns reading anchors; do not also compensate total-height deltas. */
  skipUpwardScrollCompensation?: boolean;
  initialTopMostItemIndex?: IndexLocationWithAlign | number;
}

function VirtualizedConversationInner<Item, Context>(
  {
    context,
    className,
    data,
    computeItemKey,
    itemContent,
    components,
    customScrollParent,
    followOutput,
    skipUpwardScrollCompensation,
    initialTopMostItemIndex,
  }: VirtualizedConversationProps<Item, Context>,
  ref: ForwardedRef<VirtualizedConversationHandle>,
) {
  // Initial positioning belongs to this mount; subsequent navigation uses the handle.
  const [initialLocation] = useState(initialTopMostItemIndex);
  return (
    <Virtuoso
      ref={ref}
      context={context}
      className={className}
      data={data}
      computeItemKey={computeItemKey}
      itemContent={itemContent}
      increaseViewportBy={{ top: 320, bottom: 480 }}
      // An external scroll owner compensates async row growth before paint.
      // Measure in that same frame, before its scroll event can select a range
      // using stale sizes and unmount the row that just grew (e.g. a diagram).
      skipAnimationFrameInResizeObserver={skipUpwardScrollCompensation}
      {...(components === undefined ? {} : { components })}
      {...(customScrollParent === undefined ? {} : { customScrollParent })}
      {...(followOutput === undefined ? {} : { followOutput })}
      {...(skipUpwardScrollCompensation === undefined ? {} : { skipUpwardScrollCompensation })}
      {...(initialLocation === undefined ? {} : { initialTopMostItemIndex: initialLocation })}
    />
  );
}

const ForwardedVirtualizedConversation = forwardRef(VirtualizedConversationInner);

export const VirtualizedConversation =
  // SAFETY: React.forwardRef erases the inner component's generic Item parameter;
  // this restores the same props and ref contract exposed by the implementation.
  ForwardedVirtualizedConversation as <Item, Context = unknown>(
    props: VirtualizedConversationProps<Item, Context> &
      RefAttributes<VirtualizedConversationHandle>,
  ) => ReactElement;
