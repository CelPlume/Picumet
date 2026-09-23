// 扁平化树视图（trees.software / @pierre/trees 风格）：
// - 路径优先建模：文件行 path=父目录、文件夹行 path=自身全路径 → 统一整棵子树
// - flattenEmptyDirectories：只有唯一子文件夹的文件夹链合并为一行（a/b/ ），展开/折叠按链终端
// - 平铺行渲染 + 固定行高虚拟滚动，缩进层级用逐层引导线表达
// - 缺失的中间目录由路径片段合成虚拟节点（不可选中，仅作结构）
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { revealDelay } from '@/components/ui/reveal';
import FileIcon from '@/components/files/FileIcon';
import { EmptyState } from '@/components/ui/core';
import type { FileListItem } from '@shared/types';

const ROW_H = 32;
const OVERSCAN = 8;

interface TreeNode {
  /** 链终端（或节点自身）的行；虚拟合成节点 id 为空串 */
  row: FileListItem;
  /** 链终端全路径（未扁平的文件夹 = 自身全路径） */
  fullPath: string;
  children: TreeNode[];
  /** 扁平化链的显示段（含自身名），undefined = 未发生链合并 */
  chain?: string[];
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/** 由行集合建树：先注册全部真实行（path ASC 保证父先于子），再挂接（缺失中间目录合成虚拟节点） */
function buildTree(rows: FileListItem[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const row of rows) {
    const fullPath = row.type === 'folder' ? row.path : joinPath(row.path, row.name);
    if (fullPath === '/' || nodes.has(fullPath)) continue;
    nodes.set(fullPath, { row, fullPath, children: [] });
  }
  const ensureVirtual = (fullPath: string): TreeNode => {
    const existing = nodes.get(fullPath);
    if (existing) return existing;
    const node: TreeNode = {
      row: {
        id: '', name: fullPath.slice(1), path: fullPath, type: 'folder', size: 0, hasPassword: false,
        visibility: 'private', reviewStatus: 'approved', guestVisibility: null, ownerId: '', createdAt: 0, updatedAt: 0,
      },
      fullPath,
      children: [],
    };
    nodes.set(fullPath, node);
    const parent = dirname(fullPath);
    if (parent !== '/') ensureVirtual(parent);
    return node;
  };
  for (const node of [...nodes.values()]) {
    const parent = dirname(node.fullPath);
    if (parent === '/') continue;
    ensureVirtual(parent).children.push(node);
  }
  // 排序：文件夹在前，名称不区分大小写
  const sortChildren = (list: TreeNode[]) => {
    list.sort((a, b) => {
      const af = a.row.type === 'folder' ? 0 : 1;
      const bf = b.row.type === 'folder' ? 0 : 1;
      if (af !== bf) return af - bf;
      return a.row.name.localeCompare(b.row.name, undefined, { sensitivity: 'base' });
    });
    for (const n of list) sortChildren(n.children);
  };
  const roots = [...nodes.values()].filter((n) => dirname(n.fullPath) === '/');
  sortChildren(roots);
  // 扁平化：只有唯一子文件夹的文件夹并入链（flattenEmptyDirectories）
  const collapse = (node: TreeNode): void => {
    for (const c of node.children) collapse(c);
    while (node.children.length === 1 && node.children[0].row.type === 'folder') {
      const child = node.children[0];
      node.chain = [...(node.chain ?? [node.row.name]), ...(child.chain ?? [child.row.name])];
      node.fullPath = child.fullPath;
      node.children = child.children;
    }
  };
  for (const r of roots) collapse(r);
  return roots;
}

interface FlatRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

/** DFS 生成可见行（展开集合按链终端 fullPath 记忆） */
function flattenVisible(roots: TreeNode[], expanded: Set<string>, out: FlatRow[], depth = 0): void {
  for (const node of roots) {
    const isFolder = node.row.type === 'folder';
    const isOpen = isFolder && expanded.has(node.fullPath);
    out.push({ node, depth, expanded: isOpen });
    if (isOpen) flattenVisible(node.children, expanded, out, depth + 1);
  }
}

/** 收集 currentPath 全部祖先链终端（自动展开到当前路径） */
function ancestorsOf(roots: TreeNode[], currentPath: string, into: Set<string>): boolean {
  let hit = false;
  for (const node of roots) {
    if (node.row.type !== 'folder') continue;
    if (currentPath === node.fullPath || currentPath.startsWith(node.fullPath + '/')) {
      into.add(node.fullPath);
      ancestorsOf(node.children, currentPath, into);
      hit = true;
    }
  }
  return hit;
}

export function TreeView({
  rows,
  currentPath,
  selectedId,
  onSelect,
  onOpenFile,
  onRowContext,
  renderRight,
  className,
  emptyTitle,
  emptyDesc,
}: {
  rows: FileListItem[];
  /** 高亮 + 自动展开到该路径（如文件页当前目录） */
  currentPath?: string;
  selectedId?: string | null;
  onSelect?: (row: FileListItem) => void;
  /** 双击文件回调；文件夹双击 = 展开折叠 */
  onOpenFile?: (row: FileListItem) => void;
  onRowContext?: (e: React.MouseEvent, row: FileListItem) => void;
  renderRight?: (row: FileListItem) => React.ReactNode;
  className?: string;
  emptyTitle: string;
  emptyDesc: string;
}) {
  const { t } = useTranslation();
  const roots = useMemo(() => buildTree(rows), [rows]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const set = new Set<string>();
    if (currentPath) ancestorsOf(roots, currentPath, set);
    return set;
  });
  // 数据或当前路径变化：把当前路径的祖先链并入展开集（不收起用户手动折叠的分支）
  useEffect(() => {
    if (!currentPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      ancestorsOf(roots, currentPath, next);
      return next.size === prev.size ? prev : next;
    });
  }, [roots, currentPath]);

  const visible = useMemo(() => {
    const out: FlatRow[] = [];
    flattenVisible(roots, expanded, out);
    return out;
  }, [roots, expanded]);

  // 虚拟滚动：固定行高窗口渲染
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  // 入场动画只播一次：挂载后前 700ms（最长延迟 225ms + 时长 300ms + 余量）内的可见行
  // 逐一淡入；之后（用户滚动/展开触发窗口重渲染、新挂载的行）不再重播，避免滚动时鬼影
  const [revealOn, setRevealOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setRevealOn(false), 700);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(visible.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const slice = visible.slice(start, end);

  const toggle = (fullPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  };

  if (rows.length === 0) {
    return (
      <div className={className}>
        <EmptyState title={emptyTitle} description={emptyDesc} />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      role="tree"
      className={cn('min-h-0 overflow-y-auto scrollbar-thin', className)}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: visible.length * ROW_H, position: 'relative' }}>
        <div style={{ transform: `translateY(${start * ROW_H}px)` }}>
          {slice.map(({ node, depth, expanded: isOpen }, si) => {
            const row = node.row;
            const isFolder = row.type === 'folder';
            const selected = !!row.id && row.id === selectedId;
            return (
              <div
                key={node.fullPath}
                role="treeitem"
                aria-selected={selected}
                aria-expanded={isFolder ? isOpen : undefined}
                className={cn(
                  'group flex h-8 cursor-pointer items-center gap-1 rounded-md pr-2 text-sm',
                  'hover:bg-accent/50',
                  revealOn && row.id && 'reveal-row',
                  selected && 'item-surface-selected',
                  row.banned && 'opacity-40'
                )}
                style={{ height: ROW_H, ...(row.id ? revealDelay(start + si, 'inner') : undefined) }}
                onClick={() => {
                  if (!row.id) return;
                  // 文件夹整行点击即展开/折叠（不依赖小箭头）；文件单击选中
                  if (isFolder) toggle(node.fullPath);
                  else onSelect?.(row);
                }}
                onDoubleClick={() => {
                  if (isFolder) toggle(node.fullPath);
                  else if (row.id) onOpenFile?.(row);
                }}
                onContextMenu={(e) => {
                  if (!row.id) return;
                  if (onRowContext) {
                    e.preventDefault();
                    onRowContext(e, row);
                  }
                }}
              >
                {/* 逐层缩进引导线 */}
                {Array.from({ length: depth }, (_, i) => (
                  <span key={i} aria-hidden className="h-full w-3.5 shrink-0 border-l border-border/50" />
                ))}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={isFolder ? (isOpen ? t('files.treeCollapse') : t('files.treeExpand')) : undefined}
                  className={cn('flex h-5 w-4 shrink-0 items-center justify-center rounded', isFolder ? 'hover:bg-accent' : 'pointer-events-none')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isFolder) toggle(node.fullPath);
                  }}
                >
                  {isFolder && <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />}
                </span>
                {isFolder ? (
                  isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-primary/70" /> : <Folder className="h-4 w-4 shrink-0 text-primary/70" />
                ) : (
                  <FileIcon name={row.name} type="file" className="h-4 w-4 shrink-0" />
                )}
                <span className={cn('min-w-0 truncate', !row.id && 'italic text-muted-foreground')}>
                  {/* 多级链的 / 两侧加空格降信息密度；单级文件夹保持 name/ */}
                  {node.chain ? node.chain.join(' / ') : row.name}
                  {isFolder && <span className="text-muted-foreground">{node.chain ? ' /' : '/'}</span>}
                </span>
                <span className="flex-1" />
                {renderRight?.(row)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
