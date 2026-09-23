// 网关密钥管理（对象存储中转 / PicGo / WebDAV / S3 / OpenList 兼容）
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Copy, Trash2, Check , AlertTriangle, Boxes, Database, Link2 , Wrench } from 'lucide-react';
import { Card, Button, Input, Label, EmptyState, Badge, Dialog, Switch, ConfirmDialog } from '@/components/ui/core';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { FormCardSkeleton } from '@/components/ui/skeleton';
import { revealDelay, REVEAL_INNER_BASE, REVEAL_STEP } from '@/components/ui/reveal';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { timeAgo } from '@/lib/utils';
import {SortableHeader, sortByKey, type SortOrder} from '@/components/ui/sortable-header';

interface ApiKeyItem {
  id: string;
  name: string;
  keyId: string;
  permissions: string[];
  protocols: string[];
  uploadPath: string;
  lastUsedAt?: number;
  expiresAt?: number;
  createdAt: number;
  status: string;
}

interface CreatedKey {
  key: { id: string; keyId: string; secret: string; fullToken: string; name: string; permissions: string[]; protocols: string[]; uploadPath: string };
  configs: {
    bearer: { url: string; header: string };
    webdav: { url: string; username: string; password: string; customUrlHint?: string; webpathHint?: string };
    s3: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucketHint?: string; pathStyle: boolean };
    openlist: { url: string; token: string };
  };
}

export default function ApiKeysPage() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [sort, setSort] = useState<string | null>('name');
  const [order, setOrder] = useState<SortOrder>('asc');
  const sortedKeys = useMemo(
    () => sortByKey(keys, sort as keyof ApiKeyItem, order),
    [keys, sort, order]
  );
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  /** 密钥已创建弹窗：协议配置 Tab（webdav/s3/openlist/bearer） */
  const [protoTab, setProtoTab] = useState('webdav');
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<string[]>(['write']);
  const [protocols, setProtocols] = useState<string[]>(['webdav', 'api']);
  const [uploadPath, setUploadPath] = useState('/uploads/{year}/{month}/');
  const [copyState, setCopyState] = useState('');

  const load = async () => {
    try {
      const res = await apiFetch<{ keys: ApiKeyItem[] }>('/api/keys');
      setKeys(res.data.keys);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopyState(label);
    setTimeout(() => setCopyState(''), 1500);
  };

  const create = async () => {
    if (!name) return toast('error', t('settings.apiKeys.nameRequired'));
    try {
      const res = await apiFetch<CreatedKey>('/api/keys', {
        method: 'POST',
        body: { name, permissions, protocols, uploadPath: uploadPath || '/uploads' },
      });
      setCreated(res.data);
      setProtoTab('webdav');
      setShowCreate(false);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : t('settings.apiKeys.createFailed'));
    }
  };

  const revoke = async (id: string) => {
    try {
      await apiFetch(`/api/keys/${id}`, { method: 'DELETE' });
      toast('success', t('settings.keyRevoked'));
      await load();
    } catch {
      toast('error', t('settings.apiKeys.operationFailed'));
    }
    setConfirmRevoke(null);
  };

  const togglePerm = (p: string) =>
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const toggleProto = (p: string) =>
    setProtocols((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  return (
    <div className="space-y-4">
      <div className="reveal flex items-center justify-between" style={revealDelay(0)}>
        <h2 className="text-lg font-semibold">{t('settings.nav.apiKeys')}</h2>
        <Button onClick={() => setShowCreate(true)}>
          <KeyRound className="h-4 w-4" /> {t('settings.createKey')}
        </Button>
      </div>

      {loading ? (
        <FormCardSkeleton />
      ) : (
        <Card className="reveal min-h-0 flex-1 scrollbar-thin overflow-auto py-0" style={revealDelay(1)}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className={'px-4 py-2'}><SortableHeader title={t('files.name')} sortKey="name" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
                <th className={'px-4 py-2'}>{t('settings.keyId')}</th>
                <th className={'px-4 py-2'}>{t('settings.permissions')} / {t('settings.protocols')}</th>
                <th className={'px-4 py-2'}>{t('admin.userStatus')}</th>
                <th className={'px-4 py-2'}><SortableHeader title={t('settings.lastUsed')} sortKey="lastUsedAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
                <th className={'px-4 py-2'}>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedKeys.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      icon={<KeyRound className="h-7 w-7" />}
                      title={t('settings.noKeys')}
                      description={t('settings.noKeysDesc')}
                      action={<Button onClick={() => setShowCreate(true)}><KeyRound className="h-4 w-4" /> {t('settings.createKey')}</Button>}
                    />
                  </td>
                </tr>
              ) : (
                sortedKeys.map((k, i) => (
                  <tr key={k.id} className="reveal border-b last:border-0 hover:bg-accent/50" style={revealDelay(i, 'inner', REVEAL_INNER_BASE + REVEAL_STEP)}>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <KeyRound className="h-4 w-4 text-primary" />
                        </div>
                        <span className="font-medium">{k.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{k.keyId.slice(0, 12)}...{k.keyId.slice(-6)}</td>
                    <td className="px-4 py-2">
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        {k.permissions.map((p) => <Badge key={p} variant="secondary">{p}</Badge>)}
                        {k.protocols.map((p) => <Badge key={p} variant="outline">{p}</Badge>)}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {k.status === 'active' ? <Badge variant="success">{t('settings.apiKeys.statusActive')}</Badge> : <Badge variant="destructive">{t('settings.apiKeys.statusDisabled')}</Badge>}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : t('settings.neverUsed')}</td>
                    <td className="px-4 py-2">
                      <button onClick={() => setConfirmRevoke(k.id)} className="rounded-md p-1.5 text-destructive hover:bg-destructive/10" title={t('settings.revoke')}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Card>
      )}

      {/* 创建密钥 */}
      <Dialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title={t('settings.createKey')}
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t('common.cancel')}</Button>
            <Button onClick={create}>{t('common.create')}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label>{t('settings.keyName')}</Label>
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.keyNamePlaceholder')} />
          </div>
          <div>
            <Label>{t('settings.permissions')}</Label>
            <div className="mt-1 flex gap-3">
              {['read', 'write', 'delete'].map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={permissions.includes(p)} onChange={() => togglePerm(p)} label={p} />
                  {p}
                </label>
              ))}
            </div>
          </div>
          <div>
            <Label>{t('settings.protocols')}</Label>
            <div className="mt-1 flex flex-wrap gap-3">
              {(['webdav', 'api', 's3'] as const).map((p) => (
                <label key={p} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={protocols.includes(p)} onChange={() => toggleProto(p)} label={p === 'webdav' ? t('settings.webdav') : p === 's3' ? t('settings.s3') : t('settings.customApi')} />
                  {p === 'webdav' ? t('settings.webdav') : p === 's3' ? t('settings.s3') : t('settings.customApi')}
                </label>
              ))}
            </div>
          </div>
          <div>
            <Label>{t('settings.uploadPath')}</Label>
            <Input className="mt-1 font-mono" value={uploadPath} onChange={(e) => setUploadPath(e.target.value)} placeholder={t('settings.uploadPathPlaceholder')} />
          </div>
        </div>
      </Dialog>

      {/* 创建成功 */}
      <Dialog
        open={!!created}
        onClose={() => setCreated(null)}
        title={t('settings.createKeySuccess')}
        footer={<Button onClick={() => setCreated(null)}>{t('common.close')}</Button>}
      >
        {created && (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              <AlertTriangle className="inline h-4 w-4 shrink-0" /> {t('settings.secretWarning')}
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-muted-foreground">{t('settings.keyId')}:</span>
                <code className="flex-1 truncate rounded bg-muted px-2 py-1">{created.key.keyId}</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-muted-foreground">{t('settings.secret')}:</span>
                <code className="flex-1 truncate rounded bg-muted px-2 py-1">{created.key.secret}</code>
                <Button size="sm" variant="outline" onClick={() => copy(created.key.secret, 'secret')}>
                  {copyState === 'secret' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
            {/* 协议接入配置：Tab 切换（不纵向堆叠） */}
            <Tabs value={protoTab} onValueChange={setProtoTab}>
              <TabsList>
                <TabsTrigger value="webdav">
                  <Boxes className="h-4 w-4" /> WebDAV
                </TabsTrigger>
                <TabsTrigger value="s3">
                  <Database className="h-4 w-4" /> S3
                </TabsTrigger>
                <TabsTrigger value="openlist">
                  <Link2 className="h-4 w-4" /> OpenList
                </TabsTrigger>
                <TabsTrigger value="bearer">
                  <Wrench className="h-4 w-4" /> {t('settings.customApi')}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="webdav">
                <div className="rounded-md border bg-muted/40 p-3">
                  <pre className="overflow-x-auto text-xs">
{`URL: ${created.configs.webdav.url}
${t('login.username')}: ${created.configs.webdav.username}
${t('login.password')}: ${created.configs.webdav.password}
${t('settings.apiKeys.customUrlHint')}: ${created.configs.webdav.customUrlHint ?? ''}${created.configs.webdav.webpathHint ? `\nwebpath: ${created.configs.webdav.webpathHint}` : ''}`}
                  </pre>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(JSON.stringify(created.configs.webdav), 'webdav')}>
                    {copyState === 'webdav' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {t('common.copy')}
                  </Button>
                </div>
              </TabsContent>
              <TabsContent value="s3">
                <div className="rounded-md border bg-muted/40 p-3">
                  <pre className="overflow-x-auto text-xs">
{`endpoint: ${created.configs.s3.endpoint}
region: ${created.configs.s3.region}
AccessKeyId: ${created.configs.s3.accessKeyId}
SecretAccessKey: ${created.configs.s3.secretAccessKey}
bucket: ${created.configs.s3.bucketHint ?? ''}
${t('settings.apiKeys.pathStyleAddressing')}: ${created.configs.s3.pathStyle}`}
                  </pre>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(JSON.stringify(created.configs.s3), 's3')}>
                    {copyState === 's3' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {t('common.copy')}
                  </Button>
                </div>
              </TabsContent>
              <TabsContent value="openlist">
                <div className="rounded-md border bg-muted/40 p-3">
                  <pre className="overflow-x-auto text-xs">
{`URL: ${created.configs.openlist.url}
Token: ${created.configs.openlist.token}`}
                  </pre>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(JSON.stringify(created.configs.openlist), 'openlist')}>
                    {copyState === 'openlist' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {t('common.copy')}
                  </Button>
                </div>
              </TabsContent>
              <TabsContent value="bearer">
                <div className="rounded-md border bg-muted/40 p-3">
                  <pre className="overflow-x-auto text-xs">
{`URL: ${created.configs.bearer.url}/api/upload
Header: ${created.configs.bearer.header}`}
                  </pre>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(created.configs.bearer.header, 'bearer')}>
                    {copyState === 'bearer' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {t('common.copy')}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => confirmRevoke && void revoke(confirmRevoke)}
        title={t('settings.apiKeys.revokeTitle')}
        message={t('settings.apiKeys.revokeMessage')}
      />
    </div>
  );
}
