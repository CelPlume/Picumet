// 入场原语：内容/卡片/列表/卡内元素的统一次序入场（CSS 类 .reveal 见 index.css）
//
// 形态（对照参考站实测：opacity 0→1 + 8px 上浮；区块步长 0.04s、行/元素 0.025s；
// 时长 0.3~0.45s、easeOut）：
//   - 只动 opacity 与 transform，元素首帧就占位，不产生布局位移（CLS）；
//   - mount 后只播一次（CSS 一次性动画，重渲染不重播；换路由/换页重新挂载才重播）；
//   - 逐项延迟走 CSS 变量 --reveal-delay，不给每个列表项挂 JS 定时器；
//   - 层级：卡片用 REVEAL_STEP，卡内元素/表格行用 REVEAL_STEP_FINE，卡内元素再叠加 base 偏移；
//   - data-motion 三档（default 关装饰性入场、off 全关）与 prefers-reduced-motion 均在
//     index.css 里统一关停，这里不需要任何分支。
//
// 用法一（已有元素，零额外 DOM）：
//   <Card className="reveal" style={revealDelay(i)} />
//   {rows.map((r, i) => <tr key={r.id} className="reveal" style={revealDelay(i, 0, REVEAL_STEP_FINE)}>…)}
// 用法二（需要包一层，例如卡片列表逐项错开）：
//   {cards.map((c, i) => <Reveal key={c.id} index={i}><Card>{c.body}</Card></Reveal>)}
//
// 注意：Reveal 包装元素自身不带任何布局样式（除动画），因此放进 space-y-* / grid 的
// 子项位置是布局中性的；文件页这类不定长列表只给容器加一次 .reveal，不逐行动画。
import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** 区块级（卡片/分区）逐项延迟步长（ms），对照参考站区块 0.06~0.18s 的级差 */
export const REVEAL_STEP = 40;
/** 行/元素级（表格行、列表项、表单字段组）步长（ms），参考站行间实测 0.02~0.035s */
export const REVEAL_STEP_FINE = 25;
/** 延迟封顶的项序号：第 10 项之后同延迟，长列表不会拖出长尾 */
export const REVEAL_MAX_INDEX = 9;
/** 卡内元素/行的基础偏移（ms）：等所在卡片先起跑，形成「卡片 → 卡内元素」两层节奏 */
export const REVEAL_INNER_BASE = 60;

/** 生成入场延迟（CSS 变量），用于已有元素的场景
 *  @param index  同级次序（超过 REVEAL_MAX_INDEX 后不再加长）
 *  @param layer  'block' = 卡片/分区（步长 REVEAL_STEP）；'inner' = 卡内元素/表格行（REVEAL_STEP_FINE）
 *  @param baseMs 基础偏移（ms）：卡内元素 = 所在卡片延迟 + REVEAL_INNER_BASE，先卡片后内容两层节奏
 */
export function revealDelay(index = 0, layer: 'block' | 'inner' = 'block', baseMs = 0): CSSProperties {
  const step = layer === 'inner' ? REVEAL_STEP_FINE : REVEAL_STEP;
  const capped = Math.min(Math.max(index, 0), REVEAL_MAX_INDEX) * step;
  return { '--reveal-delay': `${capped + baseMs}ms` } as CSSProperties;
}

/** 卡内逐行延迟：先等所在卡片起跑（REVEAL_INNER_BASE + 卡序×区块步长），卡内第 rowIndex 行
 *  再按细步长错开 —— 「卡片 → 卡头 → 卡内字段行」三层节奏的统一入口。
 *  用法：<CardHeader className="reveal-row" style={innerDelay(card, 0)}>、
 *       {fields.map((f, j) => <div className="reveal-row" style={innerDelay(card, j + 1)}>)} */
export function innerDelay(cardIndex = 0, rowIndex = 0): CSSProperties {
  return revealDelay(rowIndex, 'inner', REVEAL_INNER_BASE + REVEAL_STEP * Math.min(Math.max(cardIndex, 0), REVEAL_MAX_INDEX));
}

export function Reveal({
  as: Tag = 'div',
  index = 0,
  layer = 'block',
  base = 0,
  className,
  children,
  ...rest
}: {
  /** 包装元素标签，默认 div */
  as?: ElementType;
  /** 同级次序，决定 --reveal-delay */
  index?: number;
  /** 延迟层级：block = 卡片/分区，inner = 卡内元素/行 */
  layer?: 'block' | 'inner';
  /** 基础偏移（ms），叠加在 index 之上 */
  base?: number;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'style'>) {
  return (
    <Tag className={cn('reveal', className)} style={revealDelay(index, layer, base)} {...rest}>
      {children}
    </Tag>
  );
}
