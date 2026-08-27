// 鼠标拖拽多选（lasso）：Pointer Drag 拉伸半透明选框，
// 选框触碰的条目放大变强调色；下一次拖拽清空上一次选择。
// 关键：仅在实际拖拽开始（移动超阈值）后才 setPointerCapture，
// 普通点击的 pointer 事件与 click 不受影响（否则下拉/弹窗的真实点击会被劫持）。
import { useRef, useState } from 'react';
import type React from 'react';

export interface LassoRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const START_THRESHOLD = 4;

export function useLassoSelect(
  containerRef: React.RefObject<HTMLElement | null>,
  onSelect: (ids: Set<string>) => void,
  opts: { skipSelector?: string } = {}
) {
  const [rect, setRect] = useState<LassoRect | null>(null);
  const pending = useRef(false);
  const moved = useRef(false);
  const suppressClick = useRef(false);
  const startPt = useRef({ x: 0, y: 0 });
  const itemRects = useRef<Map<string, DOMRect>>(new Map());
  const capturedPointer = useRef<number | null>(null);
  const skipSelector = opts.skipSelector ?? '[data-file-card], [data-file-row], button, a, input, textarea, [role="checkbox"], [role="menuitem"]';

  const releaseCapture = () => {
    if (capturedPointer.current != null) {
      try {
        containerRef.current?.releasePointerCapture?.(capturedPointer.current);
      } catch {
        /* ignore */
      }
      capturedPointer.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(skipSelector)) return;
    pending.current = true;
    moved.current = false;
    startPt.current = { x: e.clientX, y: e.clientY };
    // 收集条目矩形（条目在拖拽期间不移动）
    const map = new Map<string, DOMRect>();
    containerRef.current?.querySelectorAll('[data-file-id]').forEach((el) => {
      const id = el.getAttribute('data-file-id');
      if (id) map.set(id, el.getBoundingClientRect());
    });
    itemRects.current = map;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pending.current) return;
    const dx = e.clientX - startPt.current.x;
    const dy = e.clientY - startPt.current.y;
    if (!moved.current && Math.hypot(dx, dy) < START_THRESHOLD) return;
    // 拖拽真正开始：此刻才捕获指针
    if (!moved.current) {
      moved.current = true;
      try {
        containerRef.current?.setPointerCapture?.(e.pointerId);
        capturedPointer.current = e.pointerId;
      } catch {
        /* 合成事件无真实指针 */
      }
    }
    const left = Math.min(startPt.current.x, e.clientX);
    const top = Math.min(startPt.current.y, e.clientY);
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    setRect({ left, top, width, height });
    // 相交判定：下一次拖拽自然替换选择集（clear selection on the next drag）
    const ids = new Set<string>();
    itemRects.current.forEach((r, id) => {
      if (r.left < left + width && r.left + r.width > left && r.top < top + height && r.top + r.height > top) {
        ids.add(id);
      }
    });
    onSelect(ids);
  };

  const endDrag = () => {
    if (moved.current) suppressClick.current = true;
    if (!pending.current && !moved.current) return;
    pending.current = false;
    moved.current = false;
    releaseCapture();
    setRect(null);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    endDrag();
    void e;
  };
  const onPointerCancel = (e: React.PointerEvent) => {
    endDrag();
    void e;
  };

  // 拖拽后抑制紧随的 click（避免行/卡片单击与多选冲突）
  const onClickCapture = (e: React.MouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { rect, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture };
}
