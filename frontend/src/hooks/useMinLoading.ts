// 骨架屏最短驻留（§33）：数据到达太快时骨架屏一闪而过，用户「几乎看不到加载动画」。
// 本钩子保证骨架屏至少展示 minMs（默认 350ms，参考站同类加载态的下限）再切换到内容；
// 数据晚于 minMs 到达时立即切换，不增加任何等待。只影响骨架屏→内容的切换时机，不延迟请求本身。
import { useEffect, useRef, useState } from 'react';

/**
 * @param loading 当前的加载态
 * @param minMs 骨架屏最短展示时长（ms）
 * @returns 显示骨架屏用的 loading：请求完成且已满足最短驻留后才变 false
 */
export function useMinLoading(loading: boolean, minMs = 350): boolean {
  // 首帧 loading=true 时记下时间戳；用 ref 而非 state，避免多余渲染
  const shownAt = useRef<number | null>(null);
  const [minLoading, setMinLoading] = useState(loading);

  useEffect(() => {
    if (loading) {
      if (shownAt.current == null) shownAt.current = Date.now();
      setMinLoading(true);
      return;
    }
    // loading 结束：距首帧不足 minMs 就等剩余时间再落 false
    const elapsed = shownAt.current == null ? minMs : Date.now() - shownAt.current;
    const remain = Math.max(0, minMs - elapsed);
    const timer = window.setTimeout(() => {
      setMinLoading(false);
      shownAt.current = null;
    }, remain);
    return () => window.clearTimeout(timer);
  }, [loading, minMs]);

  return minLoading;
}
