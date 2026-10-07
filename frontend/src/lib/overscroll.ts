// 全局过滚动引擎（外观设置「过滚动效果」）。
// 物理参数逐字取自 ~/scroll-test 参考实现：
// - 橡皮筋（fluid-scroll rubber_band.rs，iOS 同款曲线）：内容整体位移
//     disp = dir · (1 - 1/(raw/range·0.55 + 1)) · range，range = 容器可视高度；
//     整页拉出留白再弹回。
// - 松手回弹（fluid-scroll spring_back.rs）：阻尼谐振闭式解
//     offset(t) = (c1 + c2·t) · e^(-λt)，λ = 2π / response(0.575s)，
//     c1 = 松手位移，c2 = 速度(px/s) + λ·c1；|offset| < 0.1px 且速度 < 10px/s 停止。
// - 拉伸（flutter/flutter#87839 StretchingOverscrollIndicator）：内容原位变形，**无整体位移**：
//     stretch = 0.016·pull + 0.016·(1 - e^(-pull·e/0.33))，pull = 累计越界 px / 视口高度；
//     垂直滚动只做 scaleY(1 + stretch)，transform-origin 钉在被拉的边（Flutter alignment
//     映射同源：top 拉取 → topCenter，bottom 拉取 → bottomCenter）；松手 400ms 缩回
//     （_stretchDuration + Curves.decelerate）。仅作用于有真实滚动溢出的容器 —— 预留
//     高度但内容不满的卡片（管理端表格等）没有可变形的内容边缘，跳过（橡皮筋照常）。
// - 逐帧增益（Squishy OverscrollCurve.RubberBand）：越界越深增益越小；反向输入线性回退，
//     越过起点即交还原生滚动（stretch 反向直接进入缩回，同 Flutter scrollEnd → recede）。
// 变换目标：滚动上下文所在的 `.glass-surface` 卡片（项目统一卡片面）。只有卡片/表格
// 回弹 —— 页面标题、描述文字、侧栏永不跟随；落点不在卡片内（落地页裸内容等）不消费。
// 工作方式：window 级 wheel/touch 监听（wheel/touchmove non-passive），事件目标向上找
// 纵向滚动容器（先找有溢出的真实滚动容器；整链都无溢出时回落到最近的 overflow 容器，
// 供「内容未占满仍可拉拽」）；容器停在边缘且输入继续向外推时拦截事件（preventDefault
// 阻断滚动链接）施加 transform；滚轮停顿 / 触摸松手后按各自物理回弹。
// 门控：<html data-overscroll>（off 缺省不拦截）+ data-motion=off 不生效 +
// prefers-reduced-motion 不生效。
// 已知权衡：transform 祖先会让后代 backdrop-filter 退化为自身采样（AGENTS.md「Toast 玻璃
// 层级」同源约束），拉拽进行中玻璃面磨砂短暂失效，回弹结束清空 transform 即恢复 —— 这是
// 任何全站 transform 过滚动方案的固有权价。
type OverscrollEffect = 'stretch' | 'rubberBand';

type Edge = 'top' | 'bottom';

const RUBBER_BAND_COEFFICIENT = 0.55; // fluid-scroll RUBBER_BAND_COEFFICIENT
const STRETCH_INTENSITY = 0.016; // flutter _stretchIntensity
const STRETCH_EXPONENTIAL_SCALAR = Math.E / 0.33; // flutter _exponentialScalar
const STRETCH_RECEDE_EFFICIENT_MS = 340; // flutter 400ms 归入舒适档；高效再快一点点
const STRETCH_RECEDE_COMFORT_MS = 400; // flutter _stretchDuration（舒适档原速保留）
const STRETCH_RECEDE_EASING = 'cubic-bezier(0.24, 0, 0.6, 1)'; // flutter Curves.decelerate
const SPRING_RESPONSE = 0.575; // fluid-scroll DEFAULT_RESPONSE
const RUBBER_FLOOR_EFFICIENT_MS = 600; // 橡皮筋回弹最短播放（高效）：较 520ms 再慢一点点
const RUBBER_FLOOR_COMFORT_MS = 400; // 舒适档与拉伸动画同速
const WHEEL_RELEASE_DELAY = 150; // 滚轮停顿视为松手
const MAX_DISPLACEMENT_RATIO = 0.4; // 橡皮筋位移上限 = 容器高度 40%
// 拉伸比例上限分档：舒适 0.10 / 高效 0.08（见 stretchTarget）
const VALUE_THRESHOLD = 0.1; // fluid-scroll VALUE_THRESHOLD（px）
const VELOCITY_THRESHOLD = 10; // fluid-scroll 1e-2 px/ms = 10 px/s
const TOUCH_VELOCITY_CLAMP = 3; // 触摸速度钳制（px/ms），防瞬移采样爆冲

interface Session {
  /** 滚动上下文：边缘判定的容器（最近可滚动元素；未占满时可为无溢出的 overflow 容器） */
  container: HTMLElement;
  /** 变换目标：滚动上下文所在的项目统一卡片面（.glass-surface）。只有卡片/表格动，
   *  页面标题、描述、侧栏永不跟随 */
  mover: HTMLElement;
  effect: OverscrollEffect;
  edge: Edge;
  /** 位移方向：top 边缘被拉时内容向下 = +1；bottom 边缘被拉时内容向上 = -1 */
  dir: 1 | -1;
  /** 累计正向拉取输入（px，恒 ≥ 0；反向输入回退，越过 0 交还原生滚动） */
  raw: number;
  /** 当前位移（px，带方向；stretch 恒为 0 —— 原位变形无整体位移） */
  disp: number;
  /** 当前拉伸比例（flutter _stretchSize） */
  stretch: number;
  /** 累计归一化拉距（flutter _pullDistance = 越界 px / 视口高度） */
  pullNormalized: number;
  /** 松手速度（px/ms，位移方向上的分量） */
  velocity: number;
  releasing: boolean;
  raf: number;
  wheelTimer: number;
  cleanupTimer: number;
}

let session: Session | null = null;
let attrObserver: MutationObserver | null = null;
let detach: (() => void) | null = null;

/** 当前是否启用过滚动；返回生效的效果名。四个调用点共享同一门控口径 */
function activeEffect(): OverscrollEffect | null {
  const root = document.documentElement;
  const level = root.dataset.overscroll;
  if (level !== 'stretch' && level !== 'rubberBand') return null;
  if (root.dataset.motion === 'off') return null;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return null;
  }
  return level;
}

/**
 * 事件目标向上找纵向滚动容器。requireOverflow = true 只认有真实溢出的容器（正常滚动
 * 场景）；false 回落到最近的 overflow 容器——用于「内容未占满仍可拉拽」：整条链都没有
 * 溢出时，原生滚动本就无事可做，拉拽给到最近的 overflow 容器不会劫持任何滚动。
 */
function findScrollable(start: EventTarget | null, requireOverflow: boolean): HTMLElement | null {
  let node = start instanceof Element ? start : null;
  for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const oy = getComputedStyle(node).overflowY;
    const scrollable = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
    if (scrollable && (!requireOverflow || node.scrollHeight > node.clientHeight + 1)) {
      return node;
    }
  }
  const page = document.scrollingElement as HTMLElement | null;
  // 页面级滚动时变换 body 而不是 <html>：html 上挂 transform 会波及 canvas 与 fixed 层
  if (page && (!requireOverflow || page.scrollHeight > page.clientHeight + 1)) {
    return page === document.documentElement ? document.body : page;
  }
  return null;
}

/** fluid-scroll rubber_band.rs 的 iOS 曲线：raw 越大阻力越大，渐近 range */
function rubberBand(raw: number, range: number): number {
  if (raw <= 0 || range <= 0) return 0;
  const disp = (1 - 1 / ((raw / range) * RUBBER_BAND_COEFFICIENT + 1)) * range;
  return Math.min(disp, range * MAX_DISPLACEMENT_RATIO);
}

/** flutter pull() 的拉伸比例目标：线性段 + 指数饱和段。
 *  舒适档拉伸程度更大（1.0，cap 0.10），高效档收着一些（0.75，cap 0.08） */
function stretchTarget(pullNormalized: number): number {
  const comfort = document.documentElement.dataset.motionSpeed === 'comfortable';
  const linear = STRETCH_INTENSITY * pullNormalized * (comfort ? 1 : 0.75);
  const exponential = STRETCH_INTENSITY * (1 - Math.exp(-pullNormalized * STRETCH_EXPONENTIAL_SCALAR)) * (comfort ? 1 : 0.75);
  return Math.min(linear + exponential, comfort ? 0.1 : 0.08);
}

function applyTransform(s: Session): void {
  if (s.effect === 'rubberBand') {
    s.mover.style.transformOrigin = '';
    s.mover.style.transform = `translate3d(0, ${s.disp.toFixed(2)}px, 0)`;
  } else {
    // flutter alignment 映射：origin 钉在被拉的边，scaleY 让内容沿拉动方向伸长（原位变形）
    s.mover.style.transformOrigin = s.edge === 'top' ? 'center top' : 'center bottom';
    s.mover.style.transform = `scaleY(${(1 + s.stretch).toFixed(4)})`;
  }
}

/** 立即清除全部痕迹（档位切换 / 容器消失 / 新会话接管） */
function resetSession(): void {
  if (!session) return;
  cancelAnimationFrame(session.raf);
  window.clearTimeout(session.wheelTimer);
  window.clearTimeout(session.cleanupTimer);
  delete session.mover.dataset.ovsActive;
  session.mover.style.transition = '';
  session.mover.style.transform = '';
  session.mover.style.transformOrigin = '';
  session = null;
}

/** latch 期间逐帧逼近拉伸目标（flutter 用 400ms decelerate tween 收敛到 pull 目标） */
function tick(s: Session): void {
  const target = stretchTarget(s.pullNormalized);
  s.stretch += (target - s.stretch) * 0.2;
  if (Math.abs(target - s.stretch) < 0.0004) s.stretch = target;
  if (!s.mover.isConnected) {
    resetSession();
    return;
  }
  applyTransform(s);
  s.raf = requestAnimationFrame(() => tick(s));
}

/** fluid-scroll SpringBack：阻尼谐振闭式解回零（带初速度，可轻微过冲）。
 *  小振幅时物理停止点来得很快（表现为「瞬间消失」），故先估算物理停止时间，
 *  短于档位下限（高效 600ms / 舒适 400ms）时放慢时间轴，保证回弹始终可感知。 */
function springBack(s: Session): void {
  const lambda = (2 * Math.PI) / SPRING_RESPONSE;
  const c1 = s.disp;
  const c2 = s.velocity * 1e3 + lambda * c1;
  const floor = document.documentElement.dataset.motionSpeed === 'comfortable'
    ? RUBBER_FLOOR_COMFORT_MS
    : RUBBER_FLOOR_EFFICIENT_MS;
  let tEnd = 2;
  for (let t = 0; t < 2; t += 1 / 90) {
    const o = (c1 + c2 * t) * Math.exp(-lambda * t);
    const v = (c2 - lambda * (c1 + c2 * t)) * Math.exp(-lambda * t);
    if (Math.abs(o) < VALUE_THRESHOLD && Math.abs(v) < VELOCITY_THRESHOLD) {
      tEnd = t;
      break;
    }
  }
  const timeScale = Math.min(1, tEnd / (floor / 1000));
  const start = performance.now();
  const mover = s.mover;
  const step = (now: number): void => {
    if (session !== s || !s.releasing) return;
    const t = ((now - start) / 1e3) * timeScale;
    const offset = (c1 + c2 * t) * Math.exp(-lambda * t);
    const velocity = (c2 - lambda * (c1 + c2 * t)) * Math.exp(-lambda * t);
    if (Math.abs(offset) < VALUE_THRESHOLD && Math.abs(velocity) < VELOCITY_THRESHOLD) {
      resetSession();
      return;
    }
    mover.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
    s.raf = requestAnimationFrame(step);
  };
  s.raf = requestAnimationFrame(step);
}

/** flutter _recede：decelerate 缩回（无过冲）。舒适 400ms（flutter 原值），高效 340ms */
function recede(s: Session): void {
  const mover = s.mover;
  const ms = document.documentElement.dataset.motionSpeed === 'comfortable'
    ? STRETCH_RECEDE_COMFORT_MS
    : STRETCH_RECEDE_EFFICIENT_MS;
  mover.style.transition = `transform ${ms}ms ${STRETCH_RECEDE_EASING}`;
  s.raf = requestAnimationFrame(() => {
    mover.style.transform = 'scaleY(1)';
  });
  s.cleanupTimer = window.setTimeout(() => {
    if (session === s) resetSession();
  }, ms + 60);
}

function release(): void {
  if (!session || session.releasing) return;
  cancelAnimationFrame(session.raf);
  window.clearTimeout(session.wheelTimer);
  session.releasing = true;
  if (session.effect === 'rubberBand') {
    springBack(session);
  } else {
    recede(session);
  }
}

/** 顶层卡片数：直接挂在 root 下的 .glass-surface（嵌套在别的卡片里的不算，卡中卡原则） */
function topLevelCardCount(root: HTMLElement): number {
  let count = 0;
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (child.classList.contains('glass-surface')) {
        count += 1;
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return count;
}

/**
 * 解析变换目标（「卡片页面全部卡片作为一个整体」）：
 * 1) 指针落点在卡片内 → 向上找最近一个包含 ≥2 张顶层卡片的祖先（卡片群公共包裹层），
 *    全部卡片作为一个整体回弹；只有单卡 → 卡片本身。
 * 2) 侧栏（nav landmark 卡）永不回弹：落点在侧栏内不消费。
 * 3) 候选包含 nav（布局框架，卡片与侧栏的共同祖先）→ 退回卡片本身，侧栏不跟随。
 * 4) 卡片外的滚动区域（文件页网格列等）→ 滚动上下文本身，但跳过含侧栏/导航的布局框架。
 */
function resolveMover(target: EventTarget | null, container: HTMLElement): HTMLElement | null {
  if (target instanceof Element) {
    const card = target.closest<HTMLElement>('.glass-surface');
    if (card) {
      // 侧栏（nav landmark）与顶栏（header landmark）永不回弹：指针落在其上不消费
      if (card.closest('nav')) return null;
      if (card.closest('header')) return null;
      let node: HTMLElement | null = card.parentElement;
      while (node && container.contains(node) && node !== container) {
        if (node.querySelector('nav')) break;
        if (topLevelCardCount(node) >= 2) return node;
        node = node.parentElement;
      }
      return card;
    }
  }
  if (container.querySelector('aside, nav, [class*="sidebar"]')) return null;
  return container;
}

/**
 * 推进过滚动会话。
 * @param edge   本次输入对应的边缘（拉取方向）
 * @param push   本次「向边缘外推」的输入量（px，恒 ≥ 0）
 * @param forward 输入是否与已锁定会话的拉取方向同向（false = 反向回退）
 * @returns true 表示事件已消费（调用方需 preventDefault 阻断滚动链接）
 */
function advance(container: HTMLElement, effect: OverscrollEffect, edge: Edge, push: number, forward: boolean, target: EventTarget | null): boolean {
  const mover = resolveMover(target, container);
  if (!mover) return false;

  if (session && (session.mover !== mover || session.releasing)) {
    resetSession();
  }
  if (!session) {
    const dir: 1 | -1 = edge === 'top' ? 1 : -1;
    // 高效档位移距离减半（用户指定）：舒适 = 完整曲线，高效 = 1/2
    const factor = document.documentElement.dataset.motionSpeed === 'comfortable' ? 1 : 0.5;
    session = {
      container,
      mover,
      effect,
      edge,
      dir,
      raw: push,
      disp: effect === 'rubberBand' ? dir * rubberBand(push, container.clientHeight) * factor : 0,
      stretch: 0,
      pullNormalized: push / container.clientHeight,
      velocity: 0,
      releasing: false,
      raf: 0,
      wheelTimer: 0,
      cleanupTimer: 0,
    };
    // 拉拽期间条纹层切元素锚定（见 index.css [data-ovs-active]）：transform 会令
    // background-attachment: fixed 退化为元素锚定，与其首帧跳变，不如显式声明
    session.mover.dataset.ovsActive = 'true';
    if (effect === 'stretch') {
      // 首帧先给出部分拉伸再逐帧逼近目标（flutter 的 tween 语义）
      session.stretch = stretchTarget(session.pullNormalized) * 0.4;
      session.raf = requestAnimationFrame(() => tick(session!));
    }
    applyTransform(session);
    return true;
  }
  if (forward) {
    session.raw += push;
    if (session.effect === 'stretch') {
      session.pullNormalized += push / container.clientHeight;
    }
  } else {
    // 反向：stretch 直接进入缩回（flutter scrollEnd → recede）；橡皮筋线性回退
    if (session.effect === 'stretch') {
      release();
      return true;
    }
    session.raw -= push;
    if (session.raw <= 0.5) {
      release();
      return true;
    }
    session.disp = session.dir * rubberBand(session.raw, container.clientHeight);
  }
  if (session.effect === 'rubberBand') {
    const factor = document.documentElement.dataset.motionSpeed === 'comfortable' ? 1 : 0.5;
    session.disp = session.dir * rubberBand(session.raw, container.clientHeight) * factor;
  }
  applyTransform(session);
  return true;
}

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.deltaY === 0) return;
  const effect = activeEffect();
  if (!effect) return;
  const latched = session !== null && !session.releasing;
  const container = latched && session!.container.isConnected ? session!.container : findScrollable(e.target, true) ?? findScrollable(e.target, false);
  if (!container) return;
  // 滚轮 delta 归一化：行 → 16px，页 → 容器高度
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * container.clientHeight : e.deltaY;
  const atTop = container.scrollTop <= 0;
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
  // 未锁定时只认「在边缘继续向外推」；内容未占满时两条边同时可用（方向随输入）
  let edge: Edge | null = delta < 0 && atTop ? 'top' : delta > 0 && atBottom ? 'bottom' : null;
  const push = Math.abs(delta);
  let forward = true;
  if (latched && (!edge || edge !== session!.edge)) {
    // 已锁定会话的反向/换边输入：按回退量交给 advance 处理
    edge = session!.edge;
    forward = false;
  }
  if (!latched && !edge) return;
  if (advance(container, effect, edge!, push, forward, e.target)) {
    e.preventDefault();
  }
  if (session && !session.releasing) {
    window.clearTimeout(session.wheelTimer);
    session.wheelTimer = window.setTimeout(release, WHEEL_RELEASE_DELAY);
  }
}

let lastTouch = { y: 0, t: 0 };

function onTouchStart(e: TouchEvent): void {
  if (e.touches.length !== 1 || !activeEffect()) return;
  // 回弹中途再次触摸：不打断回弹动画，仅更新采样基准（新拉取会在 move 里接管）
  lastTouch = { y: e.touches[0].clientY, t: performance.now() };
}

function onTouchMove(e: TouchEvent): void {
  if (e.touches.length !== 1) return;
  const effect = activeEffect();
  if (!effect) return;
  const y = e.touches[0].clientY;
  const now = performance.now();
  const fingerDy = y - lastTouch.y; // 向下为正
  const dt = Math.max(now - lastTouch.t, 1);
  lastTouch = { y, t: now };
  const latched = session !== null && !session.releasing;
  const container = latched && session!.container.isConnected ? session!.container : findScrollable(e.target, true) ?? findScrollable(e.target, false);
  if (!container) return;
  const atTop = container.scrollTop <= 0;
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1;
  let edge: Edge | null = fingerDy > 0 && atTop ? 'top' : fingerDy < 0 && atBottom ? 'bottom' : null;
  const push = Math.abs(fingerDy);
  let forward = true;
  if (latched && (!edge || edge !== session!.edge)) {
    edge = session!.edge;
    forward = false;
  }
  if (!latched && !edge) return;
  if (advance(container, effect, edge!, push, forward, e.target)) {
    e.preventDefault();
  }
  if (session && !session.releasing) {
    const dir: 1 | -1 = session.edge === 'top' ? 1 : -1;
    session.velocity = Math.max(-TOUCH_VELOCITY_CLAMP, Math.min(TOUCH_VELOCITY_CLAMP, (dir * fingerDy) / dt));
  }
}

function onTouchEnd(): void {
  if (session && !session.releasing) release();
}

/**
 * 装载全局过滚动引擎（main.tsx 模块级调用一次）。返回卸载函数。
 * data-overscroll / data-motion 属性变化实时生效（含中途切换档位时立即归位）。
 */
export function initOverscroll(): () => void {
  if (detach) return detach;
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true });
  attrObserver = new MutationObserver(() => {
    if (!activeEffect()) resetSession();
  });
  attrObserver.observe(document.documentElement, { attributeFilter: ['data-overscroll', 'data-motion'] });
  detach = () => {
    resetSession();
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
    attrObserver?.disconnect();
    attrObserver = null;
    detach = null;
  };
  return detach;
}
