// 管理员：存储管理（存储提供商 | 挂载点配置）
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HardDrive, FolderTree } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { StorageProviders } from './storage/Providers';
import { StorageMounts } from './storage/Mounts';

export default function AdminStorage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const initialTab = params.get('tab') === 'mounts' ? 'mounts' : 'providers';
  const [tab, setTab] = useState<'providers' | 'mounts'>(initialTab);

  return (
    <div className="h-full space-y-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'providers' | 'mounts')}>
        <TabsList>
          <TabsTrigger value="providers">
            <HardDrive className="h-4 w-4" />
            存储提供商
          </TabsTrigger>
          <TabsTrigger value="mounts">
            <FolderTree className="h-4 w-4" />
            挂载点配置
          </TabsTrigger>
        </TabsList>

        <TabsContent value="providers">
          <StorageProviders />
        </TabsContent>

        <TabsContent value="mounts">
          <StorageMounts />
        </TabsContent>
      </Tabs>
    </div>
  );
}
