// 管理员：存储管理（存储提供商 | 挂载点配置）
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HardDrive, FolderTree, Plus } from 'lucide-react';
import { Button } from '@/components/ui/core';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { StorageProviders } from './storage/Providers';
import { StorageMounts } from './storage/Mounts';

export default function AdminStorage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const initialTab = params.get('tab') === 'mounts' ? 'mounts' : 'providers';
  const [tab, setTab] = useState<'providers' | 'mounts'>(initialTab);
  // 「添加」按钮与 TabsList 同行（右侧对齐）；点击经 tick 信号下发给对应子页打开弹窗
  const [addTick, setAddTick] = useState({ providers: 0, mounts: 0 });

  return (
    <div className="h-full space-y-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'providers' | 'mounts')}>
        <div className="flex shrink-0 items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="providers">
              <HardDrive className="h-4 w-4" />
              {t('admin.storage.providers')}
            </TabsTrigger>
            <TabsTrigger value="mounts">
              <FolderTree className="h-4 w-4" />
              {t('admin.storage.mounts')}
            </TabsTrigger>
          </TabsList>
          {tab === 'providers' ? (
            <Button onClick={() => setAddTick((s) => ({ ...s, providers: s.providers + 1 }))}>
              <Plus className="h-4 w-4" /> {t('admin.addProvider')}
            </Button>
          ) : (
            <Button onClick={() => setAddTick((s) => ({ ...s, mounts: s.mounts + 1 }))}>
              <Plus className="h-4 w-4" /> {t('admin.addMount')}
            </Button>
          )}
        </div>

        <TabsContent value="providers">
          <StorageProviders addTick={addTick.providers} />
        </TabsContent>

        <TabsContent value="mounts">
          <StorageMounts addTick={addTick.mounts} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
