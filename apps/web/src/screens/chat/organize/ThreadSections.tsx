import { type DragEvent, useState } from 'react';

/**
 * p10-chat-organize: the sections of the conversation list — Pinned (by pin time), one collapsible section per group
 * (its own "Load more"), and drop targets for drag and drop (desktop; phones use the "⋯" menu).
 */

export const THREAD_DRAG_TYPE = 'application/x-remyral-thread';

/** Drag source props of a conversation row. */
export function dragThread(id: string): {
  draggable: true;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
} {
  return {
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(THREAD_DRAG_TYPE, id);
      e.dataTransfer.effectAllowed = 'move';
    },
  };
}

/** Drop target props: accepts a dragged conversation and calls `onDrop(threadId)`. */
export function useDropTarget(onDrop: (threadId: string) => void): {
  over: boolean;
  props: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
} {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(THREAD_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      },
      onDragLeave: () => {
        setOver(false);
      },
      onDrop: (e) => {
        setOver(false);
        const id = e.dataTransfer.getData(THREAD_DRAG_TYPE);
        if (id === '') return;
        e.preventDefault();
        onDrop(id);
      },
    },
  };
}
