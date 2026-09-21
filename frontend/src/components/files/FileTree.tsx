// 左侧文件树：懒加载子文件夹，点击导航，高亮当前路径
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { INDICATOR_CLASS, useIndicator } from '@/components/ui/indicator';
import { useFilesQuery } from './data';

function TreeNode({
  path,
  name,
  depth,
  currentPath,
  onNavigate,
  expanded,
  toggle,
  root = false,
}: {
  path: string;
  name: string;
  depth: number;
  currentPath: string;
  onNavigate: (p: string) => void;
  expanded: Set<string>;
  toggle: (p: string) => void;
  root?: boolean;
}) {
  const isOpen = root || expanded.has(path);
  // 展开时才查询子文件夹（懒加载）
  const { data } = useFilesQuery(path, { enabled: isOpen });
  const folders = (data?.items ?? []).filter((i) => i.type === 'folder');
  const active = currentPath === path || (path !== '/' && currentPath.startsWith(path + '/'));

  return (
    <div>
      <button
        onClick={() => {
          if (!root) toggle(path);
          onNavigate(path);
        }}
        data-active={active ? 'true' : 'false'}
        className={cn(
          'relative flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm transition-colors',
          active ? 'font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
        aria-label={name}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
          style={{ opacity: root || folders.length ? 1 : 0, display: root ? 'none' : undefined }}
        />
        {/* 两种形态仅用于“已展开且非空”的文件夹：空文件夹保持收起形态 */}
        {isOpen && folders.length > 0 ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      {isOpen && folders.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {folders.map((f) => (
            <TreeNode
              key={f.id}
              path={f.path}
              name={f.name}
              depth={depth + 1}
              currentPath={currentPath}
              onNavigate={onNavigate}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ currentPath, onNavigate }: { currentPath: string; onNavigate: (p: string) => void }) {
  // 展开集合的构造：根 + currentPath 的全部祖先与自身
  const expandSetFor = (p: string) => {
    const parts = p.split('/').filter(Boolean);
    const set = new Set<string>(['/']);
    let acc = '';
    for (const seg of parts) {
      acc = `${acc}/${seg}`;
      set.add(acc);
    }
    return set;
  };

  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => expandSetFor(currentPath));

  // 切换目录时自动收起其它分支：只保留当前路径及其祖先展开
  // （含自身：点击树节点导航后该节点保持展开，空文件夹因无子级不呈现展开形态）
  useEffect(() => {
    setExpanded(expandSetFor(currentPath));
  }, [currentPath]);

  const toggle = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  // 定位与玻璃面板由 Files 页容器负责，这里只输出滚动区
  const listRef = useRef<HTMLDivElement>(null);
  const indicator = useIndicator(listRef, currentPath + '|' + expanded.size);
  return (
    <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto scrollbar-none">
      {/* 选中指示器：强调色淡化 + 随模糊三档门控，active 项之间平滑滑动（含懒加载/展开收起后校准） */}
      {indicator.ready && <span aria-hidden className={INDICATOR_CLASS} style={{ top: indicator.pos, height: indicator.size }} />}
      <TreeNode
        path="/"
        name={t('admin.files')}
        depth={0}
        currentPath={currentPath}
        onNavigate={onNavigate}
        expanded={expanded}
        toggle={toggle}
        root
      />
    </div>
  );
}
