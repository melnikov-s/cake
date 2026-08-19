/*
 * Inspired by Vercel AI Elements conversation.tsx at
 * 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0).
 * Modified by Cake to remove AI SDK contracts and add a virtualized transcript primitive.
 */
import {
  forwardRef,
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

export function ConversationEmpty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid min-h-64 place-items-center rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export type VirtualizedConversationHandle = VirtuosoHandle;

export interface VirtualizedConversationProps<Item> {
  className?: string;
  data: readonly Item[];
  computeItemKey: (index: number, item: Item) => Key;
  itemContent: (index: number, item: Item) => ReactNode;
  components?: VirtuosoProps<Item, unknown>["components"];
  atBottomStateChange?: (atBottom: boolean) => void;
  followOutput?: FollowOutput;
  initialTopMostItemIndex?: IndexLocationWithAlign | number;
}

function VirtualizedConversationInner<Item>(
  {
    className,
    data,
    computeItemKey,
    itemContent,
    components,
    atBottomStateChange,
    followOutput,
    initialTopMostItemIndex,
  }: VirtualizedConversationProps<Item>,
  ref: ForwardedRef<VirtualizedConversationHandle>,
) {
  return (
    <Virtuoso
      ref={ref}
      className={className}
      data={data}
      computeItemKey={computeItemKey}
      itemContent={itemContent}
      increaseViewportBy={{ top: 320, bottom: 480 }}
      {...(components === undefined ? {} : { components })}
      {...(atBottomStateChange === undefined ? {} : { atBottomStateChange })}
      {...(followOutput === undefined ? {} : { followOutput })}
      {...(initialTopMostItemIndex === undefined ? {} : { initialTopMostItemIndex })}
    />
  );
}

const ForwardedVirtualizedConversation = forwardRef(VirtualizedConversationInner);

export const VirtualizedConversation =
  // SAFETY: React.forwardRef erases the inner component's generic Item parameter;
  // this restores the same props and ref contract exposed by the implementation.
  ForwardedVirtualizedConversation as <Item>(
    props: VirtualizedConversationProps<Item> & RefAttributes<VirtualizedConversationHandle>,
  ) => ReactElement;
