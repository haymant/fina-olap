import { useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export interface PanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PanelInteractionOptions {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * Mouse-driven move + bottom-right resize for floating panels. Returns
 * `onDragStart` / `onResizeStart` handlers to attach to a header and a resize
 * handle; window listeners are installed only for the duration of a gesture.
 */
export function usePanelInteraction(
  rect: PanelRect,
  setRect: (next: PanelRect) => void,
  options: PanelInteractionOptions = {},
) {
  const gesture = useRef<{ mode: "drag" | "resize"; x: number; y: number; rect: PanelRect } | null>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      const g = gesture.current;
      if (!g) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (g.mode === "drag") {
        const maxLeft = Math.max(0, window.innerWidth - g.rect.width);
        const maxTop = Math.max(0, window.innerHeight - g.rect.height);
        setRect({
          ...g.rect,
          left: Math.max(0, Math.min(maxLeft, g.rect.left + dx)),
          top: Math.max(0, Math.min(maxTop, g.rect.top + dy)),
        });
        return;
      }
      const minW = options.minWidth ?? 320;
      const minH = options.minHeight ?? 200;
      const maxW = options.maxWidth ?? window.innerWidth;
      const maxH = options.maxHeight ?? window.innerHeight;
      setRect({
        ...g.rect,
        width: Math.max(minW, Math.min(maxW, g.rect.width + dx)),
        height: Math.max(minH, Math.min(maxH, g.rect.height + dy)),
      });
    },
    [setRect, options.minWidth, options.minHeight, options.maxWidth, options.maxHeight],
  );

  const onUp = useCallback(() => {
    gesture.current = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }, [onMove]);

  const begin = (mode: "drag" | "resize") => (e: ReactMouseEvent) => {
    e.preventDefault();
    gesture.current = { mode, x: e.clientX, y: e.clientY, rect };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return {
    onDragStart: begin("drag"),
    onResizeStart: begin("resize"),
  };
}
