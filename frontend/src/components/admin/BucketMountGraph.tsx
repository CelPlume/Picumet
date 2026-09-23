// 桶泳道图（git-graph 风格，曲线语言取自 git-graph-svg / react-git-log）：
// - 列布局：每层一列（列宽 COL_W，第 n 列锚点圆心 x = COL_X0 + n·COL_W）：0 = 桶、1 = 挂载点、2+ = 文件夹/文件
// - 连线：父列竖线 → 圆角转角（Q 曲线）→ 水平切入本列锚点左缘；祖先列只要「后面还有兄弟」就贯通整行，
//   展开子树时桶干线不再断开（旧实现逐行分段，展开后出现断口）
// - 配色：桶基色按层级做色相旋转（同桶同族、层级可分辨）：level 0 = 桶基色，level n = 基色 + 34n°
// - 锚点：桶 / 挂载点 / 文件夹 = 可展开节点（折叠空心、展开实心，线不穿圆），文件与计数行 = 叶子小实心点
// 展开层按模式分两种：
// - 仪表盘（BucketMountGraph）：展开 = 顶层文件夹 + 递归文件计数（只显示计数）
// - 全部文件挂载点视图（MountView）：展开 = 本桶物理存储的具体文件（分页加载）
// 备份桶：某挂载点的备用池成员且本桶 0 文件 → 琥珀 badge 挂在对应挂载点行之后（泳道内没有该挂载点行时，
// 补一行琥珀空心环的备用挂载点行，badge 紧随其后）；点击定位到主桶泳道上的那个挂载点行（3s 熄灭）；
// 拼好桶：挂载点节点出现在每个持有其文件的桶泳道上，展开只列本桶存储的文件。
import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, CornerUpLeft, Database, Folder, Settings2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import FileIcon from '@/components/files/FileIcon';
import { useMountFolderSummary, useMountTreeQuery, type BucketMountNode, type BucketNode, type TreeFileRow } from '@/components/files/data';
import { EmptyState } from '@/components/ui/core';
import type { FileListItem } from '@shared/types';

/** 泳道配色：按桶 id 稳定散列（git-graph-svg 默认色板的低饱和近亲，贴主题灰底） */
const LANE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
function laneColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length];
}

// ============ 图几何（全部 px；竖直方向用百分比 → 行高随内容/字号变化也贴合） ============

/** 相邻层列宽 */
const COL_W = 22;
/** 第 0 列（桶）锚点圆心相对行左缘的 x */
const COL_X0 = 10;
/** 可展开节点锚点半径（h-3 w-3） */
const ANCHOR_R = 6;
/** 叶子小点半径（h-1 w-1） */
const LEAF_R = 2;
/** 图行最小高度（GraphRow 的行高下限） */
const ROW_MIN_H = 26;
/** 转角盒高度（竖直引入段 + 圆弧的垂直跨度）：取半行高 → 盒顶不越过行顶，转角只在本行内展开 */
const CURVE_H = ROW_MIN_H / 2;
/** 圆角半径（Q 曲线控制点落在直角顶点 → 等值圆角）：半径拉满半行高，竖直段归零 →
    曲线贴着行顶就从父列拐出、以最长跨度缓入锚点（不再出现「竖直段挂在父列引导线上」的直角补丁） */
const CURVE_R = CURVE_H - 1;
/** 每层色相旋转角度 */
const LEVEL_HUE = 34;
/** 备用关系色（琥珀）：备用锚点环用 · 与 badge 同色系，明确「备用、本桶无文件、不可展开」 */
const STANDBY_COLOR = '#f59e0b';
/** 主桶泳道底色（备用入口定位时）：只给底色，描边留给挂载点行 —— 用户可见的主目标是挂载点行而非整条泳道 */
const LANE_HIGHLIGHT_CLASS = 'bg-primary/5';
/** 挂载点行高亮（备用入口定位的落点）：底色 + 描边，比泳道底色强一档，且全图只有挂载点行带描边 */
const ROW_HIGHLIGHT_CLASS = 'bg-primary/10 shadow-[inset_0_0_0_2px_hsl(var(--primary)/0.55)]';

/** 第 level 列锚点圆心 x */
const colX = (level: number): number => COL_X0 + level * COL_W;
/** 第 level 列行内容的左内边距：让出列宽与锚点 */
const rowPad = (level: number): number => colX(level) + ANCHOR_R + 6;

/** #rrggbb → [h(0-360), s(0-1), l(0-1)] */
function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [(h + 360) % 360, d / (1 - Math.abs(2 * l - 1)), l];
}

/** [h(0-360), s(0-1), l(0-1)] → #rrggbb */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const rgb: [number, number, number] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}

/** 层级配色：level 0 = 桶基色（与其 pill 同色），level n = 基色色相旋转 LEVEL_HUE·n（同桶同族、层级可分辨） */
function levelColor(bucketId: string, level: number): string {
  const base = laneColor(bucketId);
  if (level === 0) return base;
  const [h, s, l] = hexToHsl(base);
  return hslToHex(h + level * LEVEL_HUE, s, l);
}

/** 竖线段（2px，以列圆心对齐） */
function Line({ x, color, top = 0, height }: { x: number; color: string; top?: number | string; height: number | string }) {
  return <span aria-hidden className="absolute w-0.5" style={{ left: x - 1, top, height, backgroundColor: color }} />;
}

/** 圆角转角：父列竖线 → 圆角 → 水平段切入本列锚点左缘。
    盒高 CURVE_H 锚在行垂直中线之上，盒内没有竖直直线段：曲线起点在盒内 y=1 处（线宽 2 的描边恰好盖住盒顶）
    → 与上方父列线无缝，且拐点紧贴本行行顶，曲线以整个半行高为跨度缓入锚点。 */
function Elbow({ from, to, color, anchorR }: { from: number; to: number; color: string; anchorR: number }) {
  const w = to - from;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute overflow-visible"
      style={{ left: from - 1, top: '50%', transform: 'translateY(-100%)', width: w + 1, height: CURVE_H }}
      viewBox={`0 0 ${w + 1} ${CURVE_H}`}
    >
      <path
        d={`M 1 1 Q 1 ${CURVE_H} ${1 + CURVE_R} ${CURVE_H} L ${w + 1 - anchorR} ${CURVE_H}`}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 锚点：桶/挂载点/文件夹按展开态空心（折叠）- 实心（展开），无外圈；叶子（文件、计数行）为小实心点 */
function Anchor({ x, kind, color }: { x: number; kind: 'solid' | 'hollow' | 'leaf'; color: string }) {
  const leaf = kind === 'leaf';
  return (
    <span
      aria-hidden
      className={cn('absolute -translate-y-1/2 rounded-full', leaf ? 'h-1 w-1' : 'h-3 w-3', kind === 'hollow' && 'border-2 bg-transparent')}
      style={{
        left: x - (leaf ? LEAF_R : ANCHOR_R),
        top: '50%',
        ...(kind === 'hollow' ? { borderColor: color } : { backgroundColor: color }),
      }}
    />
  );
}

/** 图行：祖先列贯通竖线 + 父列 → 本列圆角入边 + 锚点 + 行内容。
    子树由调用方紧跟在 GraphRow 之后的兄弟 div 渲染（无间距），竖线靠子行按 pass 接力 → 展开不断线 */
function GraphRow({
  level,
  bucketId,
  pass,
  parent,
  anchor,
  stub,
  highlight,
  mountNodeId,
  children,
}: {
  /** 本行列号：0 = 桶、1 = 挂载点、2+ = 文件夹/文件 */
  level: number;
  bucketId: string;
  /** 祖先列是否贯通本行：索引 = 列号（0..level-2），长度 = level-1 */
  pass: boolean[];
  /** 父列竖线：'full' = 本行后面还有兄弟（线继续向下）；'toCurve' = 末子（止于转角）；null = 无父（桶行） */
  parent: 'full' | 'toCurve' | null;
  anchor: 'solid' | 'hollow' | 'leaf';
  /** 展开态：锚点下缘 → 行底的短线，接住子行的父列竖线 */
  stub?: boolean;
  /** 被备用入口定位中的挂载点行：整行描边 + 底色 */
  highlight?: boolean;
  /** 挂载点 id → 渲染 data-mount-node（备用入口按此定位到主桶泳道上的挂载点行） */
  mountNodeId?: string;
  children: React.ReactNode;
}) {
  const x = colX(level);
  const color = levelColor(bucketId, level);
  return (
    <div
      className={cn('relative flex items-center rounded-md', highlight && ROW_HIGHLIGHT_CLASS)}
      style={{ paddingLeft: rowPad(level), minHeight: ROW_MIN_H }}
      {...(mountNodeId ? { 'data-mount-node': mountNodeId } : {})}
    >
      {pass.map((through, col) => (through ? <Line key={col} x={colX(col)} color={levelColor(bucketId, col)} height="100%" /> : null))}
      {parent && (
        // 'toCurve' 末子：父列线止于转角盒内 1px（而非盒顶），让转角起点圆头描边的锥尖始终压在父列色上 → 接缝无发丝隙
        <Line
          x={colX(level - 1)}
          color={levelColor(bucketId, level - 1)}
          height={parent === 'full' ? '100%' : `calc(50% - ${CURVE_H - 1}px)`}
        />
      )}
      {parent && <Elbow from={colX(level - 1)} to={x} color={color} anchorR={anchor === 'leaf' ? LEAF_R : ANCHOR_R} />}
      {stub && <Line x={x} color={color} top={`calc(50% + ${ANCHOR_R}px)`} height={`calc(50% - ${ANCHOR_R}px)`} />}
      <Anchor x={x} kind={anchor} color={color} />
      {children}
    </div>
  );
}

// ============ 泳道 / 节点 ============

/** 备用关系条目：本桶是某挂载点的备用池成员且本桶 0 文件（bucketTree.standbys） */
type StandbyEntry = BucketNode['standbys'][number];

/** 备用桶 badge：点击定位主桶泳道上的那个挂载点行（滚动 + 高亮，3 秒熄灭） */
function StandbyBadge({ standby, onHighlight }: { standby: StandbyEntry; onHighlight: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onHighlight}
      title={t('admin.allFiles.highlightPrimary', { name: standby.primaryProviderName })}
      className="inline-flex max-w-full shrink-0 items-center gap-1.5 truncate rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
    >
      <CornerUpLeft className="h-3 w-3 shrink-0" />
      <span className="truncate">{t('admin.allFiles.standbyFor', { mount: standby.mountName })}</span>
      <span className="shrink-0 opacity-60">→ {standby.primaryProviderName}</span>
    </button>
  );
}

/** 备用入口定位：点击备用 badge / 备用行 → 主桶泳道上的那个挂载点行（滚动 + 高亮描边），3 秒自动熄灭
    （仪表盘 / 挂载点视图共用；主桶泳道同时给底色高亮，但落点始终是挂载点行而非整条泳道） */
function useMountHighlight() {
  const [target, setTarget] = useState<{ bucketId: string; mountId: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const highlight = (bucketId: string, mountId: string) => {
    setTarget({ bucketId, mountId });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setTarget(null), 3000);
  };
  // DOM 提交后再滚动：主桶泳道可能刚被展开，挂载点行此刻才存在
  useEffect(() => {
    if (!target) return;
    const lane = document.querySelector(`[data-bucket-lane="${CSS.escape(target.bucketId)}"]`);
    const row = lane?.querySelector(`[data-mount-node="${CSS.escape(target.mountId)}"]`);
    (row ?? lane)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [target]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { highlightTarget: target, highlightMount: highlight };
}

/** 泳道交互状态（仪表盘 / 挂载点视图共用）：桶折叠集合 + 挂载点多开集合 + 备用入口定位（含自动展开主桶）。 */
function useLaneState() {
  /** 挂载点展开集合（可同时展开多个）；桶默认展开，collapsedBuckets 记录被折叠的桶 */
  const [openMounts, setOpenMounts] = useState<Set<string>>(new Set());
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<string>>(new Set());
  const { highlightTarget, highlightMount } = useMountHighlight();
  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const highlightPrimaryMount = (bucketId: string, mountId: string) => {
    // 主桶泳道折叠时挂载点行不在 DOM 里 → 先展开，再滚动高亮
    setCollapsedBuckets((prev) => {
      if (!prev.has(bucketId)) return prev;
      const next = new Set(prev);
      next.delete(bucketId);
      return next;
    });
    highlightMount(bucketId, mountId);
  };
  return {
    openMounts,
    collapsedBuckets,
    toggleMount: (key: string) => toggle(setOpenMounts, key),
    toggleBucket: (id: string) => toggle(setCollapsedBuckets, id),
    highlightTarget,
    highlightPrimaryMount,
  };
}

/** 桶头行内容：折叠箭头 + 桶名 pill（桶基色）+ 桶标识 + 计数 */
function BucketHeader({ b, open, onToggle }: { b: BucketNode; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/40"
    >
      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      <span
        className="inline-flex max-w-full items-center truncate rounded-full px-2.5 py-1 text-xs font-semibold text-white"
        style={{ backgroundColor: laneColor(b.id) }}
        title={`${b.name} · ${b.bucket}`}
      >
        {b.name}
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground" title={b.bucket}>{b.bucket}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {t('admin.dashboard.filesCount', { count: b.fileCount })} · {formatBytes(b.usedSpace)}
      </span>
    </button>
  );
}

/** 泳道壳：桶头图行（level 0）+ 展开的子树容器；highlighted = 备用入口定位到本桶泳道的挂载点行时的底色 */
function BucketLane({
  b,
  highlighted,
  open,
  onToggle,
  children,
}: {
  b: BucketNode;
  highlighted?: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      data-bucket-lane={b.id}
      className={cn('relative rounded-lg p-1 transition-colors', highlighted && LANE_HIGHLIGHT_CLASS)}
    >
      <GraphRow
        level={0}
        bucketId={b.id}
        pass={[]}
        parent={null}
        anchor={open ? 'solid' : 'hollow'}
        stub={open && b.mounts.length > 0}
      >
        <BucketHeader b={b} open={open} onToggle={onToggle} />
      </GraphRow>
      {open && <div>{children}</div>}
    </div>
  );
}

/** 挂载点节点行（level 1）：桶列 → 挂载点列的圆角入边 + 展开子树；highlighted = 被备用入口定位中 */
function MountRow({
  bucketId,
  m,
  isLast,
  open,
  highlighted,
  onToggle,
  children,
}: {
  bucketId: string;
  m: BucketMountNode;
  /** 本桶最后一个挂载点 → 父列（桶列）竖线止于转角 */
  isLast: boolean;
  open: boolean;
  highlighted?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <GraphRow
        level={1}
        bucketId={bucketId}
        pass={[]}
        parent={isLast ? 'toCurve' : 'full'}
        anchor={open ? 'solid' : 'hollow'}
        stub={open}
        highlight={highlighted}
        mountNodeId={m.id}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/60',
            open && 'bg-accent/60'
          )}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="truncate text-xs font-medium" title={m.mountPath}>{m.name}</span>
          <span className="hidden truncate font-mono text-[10px] text-muted-foreground sm:block">{m.mountPath}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {t('admin.dashboard.filesCount', { count: m.fileCount })} · {formatBytes(m.usedSpace)}
          </span>
        </button>
      </GraphRow>
      {open && <div>{children}</div>}
    </div>
  );
}

/** 泳道内非图行：备用桶 badge（挂载点行已存在时紧随其后）与"无挂载点"提示（对齐 level 1 内容列，不画连线） */
function LaneLabel({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 items-center py-0.5 text-[11px] text-muted-foreground" style={{ paddingLeft: rowPad(1) }}>{children}</div>;
}

/** 备用挂载点行（level 1）：本桶是某挂载点的备用池成员且本桶 0 文件、泳道上没有该挂载点的行时渲染。
    与挂载点行同列同缩进，但锚点为琥珀空心环（备用关系、不可展开，故不渲染折叠箭头，仅以等宽占位对齐标题列），
    且不接桶干线 —— 「连着桶干线 = 本桶持有该挂载点文件，不连的琥珀环 = 仅备用」一眼可分。
    整行与 badge 都定位到主桶泳道上的挂载点行。 */
function StandbyMountNode({ standby, onHighlight }: { standby: StandbyEntry; onHighlight: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="relative flex items-center" data-standby-node={standby.mountId} style={{ paddingLeft: rowPad(1), minHeight: ROW_MIN_H }}>
      <Anchor x={colX(1)} kind="hollow" color={STANDBY_COLOR} />
      <button
        type="button"
        onClick={onHighlight}
        title={t('admin.allFiles.highlightPrimary', { name: standby.primaryProviderName })}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/60"
      >
        <span aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate text-xs font-medium" title={standby.mountPath}>{standby.mountName}</span>
        <span className="hidden truncate font-mono text-[10px] text-muted-foreground sm:block">{standby.mountPath}</span>
      </button>
      <StandbyBadge standby={standby} onHighlight={onHighlight} />
    </div>
  );
}

/** 泳道内容：挂载点行（可展开，多开）+ 紧跟其后的备用条目 + 无对应挂载点行的备用挂载点占位行。
    仪表盘与挂载点视图共用，差异只有「挂载点展开层」→ renderMountContent（计数 or 具体文件）。 */
function LaneNodes({
  b,
  openMounts,
  onToggleMount,
  highlightTarget,
  onHighlightMount,
  renderMountContent,
}: {
  b: BucketNode;
  openMounts: Set<string>;
  onToggleMount: (key: string) => void;
  highlightTarget: { bucketId: string; mountId: string } | null;
  onHighlightMount: (bucketId: string, mountId: string) => void;
  renderMountContent: (m: BucketMountNode, trunk: boolean) => React.ReactNode;
}) {
  const { t } = useTranslation();
  // 备用条目按 mountId 归属：有同 mountId 挂载点行的紧随该行（§31 显式备用标记下两个列表可重叠），
  // 其余（本桶 0 文件、无该挂载点行）渲染为备用挂载点占位行
  const mountIds = new Set(b.mounts.map((m) => m.id));
  const standbysByMount = new Map<string, StandbyEntry[]>();
  const orphanStandbys: StandbyEntry[] = [];
  for (const s of b.standbys) {
    if (!mountIds.has(s.mountId)) {
      orphanStandbys.push(s);
      continue;
    }
    const list = standbysByMount.get(s.mountId);
    if (list) list.push(s);
    else standbysByMount.set(s.mountId, [s]);
  }
  return (
    <>
      {b.mounts.length === 0 && b.standbys.length === 0 && <LaneLabel>{t('admin.dashboard.bucketNoMounts')}</LaneLabel>}
      {b.mounts.map((m, mi) => {
        const key = `${b.id}:${m.id}`;
        const open = openMounts.has(key);
        // 备用行不接桶干线 → 桶列竖线/子树贯通只看挂载点，不看备用行
        const isLast = mi === b.mounts.length - 1;
        return (
          <Fragment key={key}>
            <MountRow
              bucketId={b.id}
              m={m}
              isLast={isLast}
              open={open}
              highlighted={highlightTarget?.bucketId === b.id && highlightTarget.mountId === m.id}
              onToggle={() => onToggleMount(key)}
            >
              {open && renderMountContent(m, !isLast)}
            </MountRow>
            {(standbysByMount.get(m.id) ?? []).map((s) => (
              <LaneLabel key={`${b.id}:${s.mountId}`}>
                <StandbyBadge standby={s} onHighlight={() => onHighlightMount(s.primaryProviderId, s.mountId)} />
              </LaneLabel>
            ))}
          </Fragment>
        );
      })}
      {orphanStandbys.map((s) => (
        <StandbyMountNode
          key={`${b.id}:${s.mountId}`}
          standby={s}
          onHighlight={() => onHighlightMount(s.primaryProviderId, s.mountId)}
        />
      ))}
    </>
  );
}

// ============ 仪表盘 ============

/** 挂载点展开层（仪表盘）：顶层文件夹 + 每夹递归文件计数（本桶过滤，0 文件夹隐藏）；每条一个叶子图行 */
function MountFolderSummary({ bucketId, mountId, trunk }: { bucketId: string; mountId: string; trunk: boolean }) {
  const { t } = useTranslation();
  // 仪表盘 bucketTree 中桶 id 即 provider id
  const { data, isLoading } = useMountFolderSummary(mountId, bucketId);
  if (isLoading) {
    return (
      <div className="space-y-1 py-1" style={{ paddingLeft: rowPad(2) }}>
        {[0, 1].map((i) => <div key={i} className="h-4 w-40 animate-pulse rounded bg-muted" />)}
      </div>
    );
  }
  if (!data) return null;
  const entries = [
    ...(data.rootFiles.count > 0
      ? [{ key: 'root', icon: <Database className="h-3 w-3 shrink-0" />, label: t('admin.dashboard.rootFiles'), count: data.rootFiles.count, size: data.rootFiles.size }]
      : []),
    ...data.folders.map((f) => ({ key: f.id, icon: <Folder className="h-3 w-3 shrink-0 text-primary/70" />, label: f.name, count: f.fileCount, size: f.usedSpace })),
  ];
  const rows = entries.length > 0 ? entries : [{ key: 'empty', icon: null, label: t('admin.allFiles.bucketEmpty'), count: null, size: null }];
  return (
    <div className="text-xs">
      {rows.map((r, i) => (
        <GraphRow key={r.key} level={2} bucketId={bucketId} pass={[trunk]} parent={i === rows.length - 1 ? 'toCurve' : 'full'} anchor="leaf">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 hover:bg-accent/40">
            {r.icon}
            <span className="min-w-0 truncate">{r.label}</span>
            {r.count != null && (
              <span className="ml-auto shrink-0 text-muted-foreground">
                {t('admin.dashboard.filesCount', { count: r.count })} · {formatBytes(r.size ?? 0)}
              </span>
            )}
          </div>
        </GraphRow>
      ))}
    </div>
  );
}

function DashboardBucketGraphInner({ buckets }: { buckets: BucketNode[] }) {
  const { openMounts, collapsedBuckets, toggleMount, toggleBucket, highlightTarget, highlightPrimaryMount } = useLaneState();
  return (
    <div className="space-y-3">
      {buckets.map((b) => (
        <BucketLane
          key={b.id}
          b={b}
          highlighted={highlightTarget?.bucketId === b.id}
          open={!collapsedBuckets.has(b.id)}
          onToggle={() => toggleBucket(b.id)}
        >
          <LaneNodes
            b={b}
            openMounts={openMounts}
            onToggleMount={toggleMount}
            highlightTarget={highlightTarget}
            onHighlightMount={highlightPrimaryMount}
            renderMountContent={(m, trunk) => <MountFolderSummary bucketId={b.id} mountId={m.id} trunk={trunk} />}
          />
        </BucketLane>
      ))}
    </div>
  );
}

/** 仪表盘：活跃挂载点桶泳道图 */
export function BucketMountGraph({ buckets }: { buckets: BucketNode[] }) {
  return <DashboardBucketGraphInner buckets={buckets} />;
}

// ============ 全部文件 · 挂载点视图 ============

/** 单条文件行：图标 + 名称（封禁半透明）+ 属主 + 大小 + 属性设置入口 */
function MountFileRow({ f, onOpenSettings }: { f: TreeFileRow; onOpenSettings: (f: FileListItem) => void }) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/40', f.banned && 'opacity-40')}>
      <FileIcon name={f.name} type={f.type} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{f.name}</span>
      <span className="ml-auto hidden shrink-0 text-muted-foreground sm:block">{f.ownerName || f.ownerId.slice(0, 8)}</span>
      <span className="w-16 shrink-0 text-right text-muted-foreground">{f.type === 'folder' ? '-' : formatBytes(f.size)}</span>
      <button
        type="button"
        onClick={() => onOpenSettings(f)}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t('admin.allFiles.settings')}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** 挂载点展开层（挂载点视图）：本桶物理存储的文件按 挂载点 → 文件夹 → 文件 分级，每行一个图行
    （文件夹 = 可展开锚点、文件 = 叶子点）；bucket 筛选只作用于文件行，文件夹行保留作骨架 */
function MountContent({
  bucketId,
  mountId,
  mountPath,
  trunk,
  refreshKey,
  onOpenSettings,
}: {
  bucketId: string;
  mountId: string;
  mountPath: string;
  /** 本桶在此挂载点之后还有别的挂载点 → 桶列竖线要贯通本子树 */
  trunk: boolean;
  refreshKey: number;
  onOpenSettings: (f: FileListItem) => void;
}) {
  const { t } = useTranslation();
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['admin-mount-content', mountId, bucketId, refreshKey],
    queryFn: async () => {
      const q = new URLSearchParams({ mount: mountId, bucket: bucketId });
      return (await apiFetch<{ items: TreeFileRow[]; truncated: boolean }>(`/api/admin/files/tree?${q.toString()}`)).data;
    },
  });
  const emptyRow = (
    <GraphRow level={2} bucketId={bucketId} pass={[trunk]} parent="toCurve" anchor="leaf">
      <p className="px-2 py-1 text-xs text-muted-foreground">{t('admin.allFiles.bucketEmpty')}</p>
    </GraphRow>
  );
  if (isLoading && !data) {
    return (
      <div className="space-y-1 py-1" style={{ paddingLeft: rowPad(2) }}>
        {[0, 1, 2].map((i) => <div key={i} className="h-5 w-full animate-pulse rounded bg-muted" />)}
      </div>
    );
  }
  const rows = data?.items ?? [];
  if (rows.length === 0) return emptyRow;
  // 行内 path 语义：文件夹行 path = 自身全路径、文件行 path = 父目录
  const parentOf = (r: TreeFileRow) => (r.type === 'folder' ? r.path.split('/').slice(0, -1).join('/') || '/' : r.path);
  const childrenOf = (parent: string): TreeFileRow[] =>
    rows
      .filter((r) => parentOf(r) === parent)
      .sort((a, b) => {
        const af = a.type === 'folder' ? 0 : 1;
        const bf = b.type === 'folder' ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  const toggleFolder = (p: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };
  /** 递归渲染一层：pass 索引 = 列号（0 桶、1 挂载点、2+ 文件夹）；末子把父列让给转角 */
  const renderLevel = (parent: string, depth: number, pass: boolean[]): React.ReactNode => {
    const kids = childrenOf(parent);
    return kids.map((r, i) => {
      const isLast = i === kids.length - 1;
      const isFolder = r.type === 'folder';
      const open = isFolder && openFolders.has(r.path);
      const grandKids = isFolder && open ? childrenOf(r.path) : [];
      return (
        <div key={r.id || r.path}>
          <GraphRow
            level={2 + depth}
            bucketId={bucketId}
            pass={pass}
            parent={isLast ? 'toCurve' : 'full'}
            anchor={isFolder ? (open ? 'solid' : 'hollow') : 'leaf'}
            stub={open && grandKids.length > 0}
          >
            {isFolder ? (
              <button
                type="button"
                onClick={() => toggleFolder(r.path)}
                aria-expanded={open}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-accent/40"
              >
                <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span className="min-w-0 truncate">{r.name}</span>
                <span className="text-muted-foreground">/</span>
              </button>
            ) : (
              <MountFileRow f={r} onOpenSettings={onOpenSettings} />
            )}
          </GraphRow>
          {open && grandKids.length > 0 && <div>{renderLevel(r.path, depth + 1, [...pass, !isLast])}</div>}
        </div>
      );
    });
  };
  return (
    <div>
      {data?.truncated && <p className="px-2 py-0.5 text-[11px] text-amber-600">{t('files.treeTruncated')}</p>}
      {renderLevel(mountPath, 0, [trunk])}
      {rows.every((r) => parentOf(r) !== mountPath) && emptyRow}
    </div>
  );
}

/** 全部文件页挂载点视图：桶 → 挂载点（本桶文件）+ 备用桶 badge；桶可折叠（默认展开），挂载点可多开 */
export function MountView({ refreshKey, onOpenSettings }: { refreshKey: number; onOpenSettings: (f: FileListItem) => void }) {
  const { t } = useTranslation();
  const { openMounts, collapsedBuckets, toggleMount, toggleBucket, highlightTarget, highlightPrimaryMount } = useLaneState();
  const { data, isLoading } = useMountTreeQuery();
  if (isLoading) {
    return <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <div key={i} className="h-8 w-full animate-pulse rounded bg-muted" />)}</div>;
  }
  const buckets = data?.buckets ?? [];
  if (buckets.length === 0) {
    return <EmptyState compact icon={<Database className="h-4 w-4" />} title={t('admin.dashboard.noMounts')} description={t('admin.dashboard.noMountsDesc')} />;
  }
  return (
    <div className="space-y-3 p-4">
      {buckets.map((b) => (
        <BucketLane
          key={b.id}
          b={b}
          highlighted={highlightTarget?.bucketId === b.id}
          open={!collapsedBuckets.has(b.id)}
          onToggle={() => toggleBucket(b.id)}
        >
          <LaneNodes
            b={b}
            openMounts={openMounts}
            onToggleMount={toggleMount}
            highlightTarget={highlightTarget}
            onHighlightMount={highlightPrimaryMount}
            renderMountContent={(m, trunk) => (
              <MountContent
                bucketId={b.id}
                mountId={m.id}
                mountPath={m.mountPath}
                trunk={trunk}
                refreshKey={refreshKey}
                onOpenSettings={onOpenSettings}
              />
            )}
          />
        </BucketLane>
      ))}
    </div>
  );
}
