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
  type AriaRole,
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
  atBottomStateChange?: (atBottom: boolean) => void;
  followOutput?: FollowOutput;
  totalListHeightChanged?: (height: number) => void;
  initialTopMostItemIndex?: IndexLocationWithAlign | number;
  rangeChanged?: VirtuosoProps<Item, unknown>["rangeChanged"];
  scrollerRef?: VirtuosoProps<Item, unknown>["scrollerRef"];
  role?: AriaRole;
  "aria-label"?: string;
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
    atBottomStateChange,
    followOutput,
    totalListHeightChanged,
    initialTopMostItemIndex,
    rangeChanged,
    scrollerRef,
    role,
    "aria-label": ariaLabel,
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
      {...(components === undefined ? {} : { components })}
      {...(customScrollParent === undefined ? {} : { customScrollParent })}
      {...(atBottomStateChange === undefined ? {} : { atBottomStateChange })}
      {...(followOutput === undefined ? {} : { followOutput })}
      {...(totalListHeightChanged === undefined ? {} : { totalListHeightChanged })}
      {...(initialLocation === undefined ? {} : { initialTopMostItemIndex: initialLocation })}
      {...(rangeChanged === undefined ? {} : { rangeChanged })}
      {...(scrollerRef === undefined ? {} : { scrollerRef })}
      {...(role === undefined ? {} : { role })}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
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
