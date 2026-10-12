// 网关密钥管理（对象存储中转 / PicGo / WebDAV / S3 / OpenList 兼容）
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Copy, Trash2, Check , AlertTriangle, Boxes, Database, Link2 , Wrench } from 'lucide-react';
import { Card, Button, Input, Label, EmptyState, Badge, Dialog, Switch, ConfirmDialog } from '@/components/ui/core';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { TableSkeleton } from '@/components/ui/skeleton';
import { revealDelay, REVEAL_INNER_BASE, REVEAL_STEP } from '@/components/ui/reveal';
import { CheckboxWithLabel } from '@/components/ui/checkbox';
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
    bearer: { url: string; header: string; pathHint?: string };
    webdav: { url: string; username: string; password: string; customUrlHint?: string; webpathHint?: string };
    s3: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucketHint?: string; keyPrefixHint?: string; pathStyle: boolean };
    openlist: { url: string; token: string; pathHint?: string };
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
  // 留空 = 服务端默认：user_space 挂载上的普通用户 → 其用户空间目录；其余 → /uploads。支持 {year}/{month} 模板
  const [uploadPath, setUploadPath] = useState('');
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
    toast('success', t('common.copied'));
  };

  const create = async () => {
    if (!name) return toast('error', t('settings.apiKeys.nameRequired'));
    try {
      const res = await apiFetch<CreatedKey>('/api/keys', {
        method: 'POST',
        body: { name, permissions, protocols, ...(uploadPath.trim() ? { uploadPath: uploadPath.trim() } : {}) },
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

  /**
   * 协议参数块：每个参数一行可复制文本框（右侧复制按钮），底部「复制全部」。
   * 单行复制与展示逐行一致（`key: value`）；「复制全部」沿用 JSON 格式（配置对象整份，便于粘贴到工具）。
   */
  const ConfigRows = ({
    tab,
    rows,
    copyAllPayload,
  }: {
    tab: string;
    rows: Array<[string, string]>;
    copyAllPayload: string;
  }) => {
    return (
      <div className="rounded-md border bg-muted/40 p-3">
        {rows.map(([k, v]) => (
          <div key={k} className="group flex items-center gap-2 py-0.5">
            <pre className="flex-1 overflow-x-auto text-xs whitespace-pre">{`${k}: ${v}`}</pre>
            <button
              onClick={() => void copy(`${k}: ${v}`, `${tab}-line-${k}`)}
              className="shrink-0 rounded p-1 text-muted-foreground transition-opacity group-hover:opacity-100 focus:opacity-100"
              title={t('common.copy')}
              aria-label={`${t('common.copy')}: ${k}`}
            >
              {copyState === `${tab}-line-${k}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => void copy(copyAllPayload, tab)}
        >
          {copyState === tab ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {t('settings.apiKeys.copyAll')}
        </Button>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="reveal flex items-center justify-between" style={revealDelay(0)}>
        <h2 className="text-lg font-semibold">{t('settings.nav.apiKeys')}</h2>
        <Button onClick={() => setShowCreate(true)}>
          <KeyRound className="h-4 w-4" /> {t('settings.createKey')}
        </Button>
      </div>

      <Card className="reveal min-h-0 flex-1 scrollbar-thin overflow-auto py-0" style={revealDelay(1)}>
        {loading ? (
          <div className="p-4">
            <TableSkeleton rows={6} cols={5} />
          </div>
        ) : (
        <div className="animate-fade-in">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className={'px-4 py-2'}><SortableHeader title={t('files.name')} sortKey="name" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
                <th className={'px-4 py-2'}>{t('settings.keyId')}</th>
                <th className={'px-4 py-2'}>{t('settings.permissions')}</th>
                <th className={'px-4 py-2'}>{t('settings.protocols')}</th>
                <th className={'px-4 py-2'}>{t('admin.userStatus')}</th>
                <th className={'px-4 py-2'}><SortableHeader title={t('settings.lastUsed')} sortKey="lastUsedAt" sort={sort} order={order} onSort={(k)=>{setSort(k);setOrder(order==='asc'?'desc':'asc');}} /></th>
                <th className={'px-4 py-2'}>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedKeys.length === 0 ? (
                <tr>
                  <td colSpan={7}>
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
                      <div className="flex flex-wrap gap-1">
                        {k.permissions.map((p) => <Badge key={p} variant="secondary">{p}</Badge>)}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
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
        </div>
        )}
      </Card>

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
                <CheckboxWithLabel
                  key={p}
                  checked={permissions.includes(p)}
                  onChange={() => togglePerm(p)}
                  label={p}
                />
              ))}
            </div>
          </div>
          <div>
            <Label>{t('settings.protocols')}</Label>
            <div className="mt-1 flex flex-wrap gap-3">
              {(['webdav', 'api', 's3'] as const).map((p) => (
                <CheckboxWithLabel
                  key={p}
                  checked={protocols.includes(p)}
                  onChange={() => toggleProto(p)}
                  label={p === 'webdav' ? t('settings.webdav') : p === 's3' ? t('settings.s3') : t('settings.customApi')}
                />
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
        width="max-w-3xl"
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
                <Button size="sm" variant="outline" onClick={() => void copy(created.key.keyId, 'keyId')}>
                  {copyState === 'keyId' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-muted-foreground">{t('settings.secret')}:</span>
                <code className="flex-1 truncate rounded bg-muted px-2 py-1">{created.key.secret}</code>
                <Button size="sm" variant="outline" onClick={() => void copy(created.key.secret, 'secret')}>
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
                <ConfigRows
                  tab="webdav"
                  rows={[
                    ['URL', created.configs.webdav.url],
                    [t('login.username'), created.configs.webdav.username],
                    [t('login.password'), created.configs.webdav.password],
                    ...(created.configs.webdav.customUrlHint ? [[t('settings.apiKeys.customUrlHint'), created.configs.webdav.customUrlHint]] as Array<[string, string]> : []),
                    ...(created.configs.webdav.webpathHint ? [['webpath', created.configs.webdav.webpathHint]] as Array<[string, string]> : []),
                  ]}
                  copyAllPayload={JSON.stringify(created.configs.webdav, null, 2)}
                />
              </TabsContent>
              <TabsContent value="s3">
                <ConfigRows
                  tab="s3"
                  rows={[
                    ['endpoint', created.configs.s3.endpoint],
                    ['region', created.configs.s3.region],
                    ['AccessKeyId', created.configs.s3.accessKeyId],
                    ['SecretAccessKey', created.configs.s3.secretAccessKey],
                    ['bucket', created.configs.s3.bucketHint ?? ''],
                    ...(created.configs.s3.keyPrefixHint ? [['keyPrefix', created.configs.s3.keyPrefixHint]] as Array<[string, string]> : []),
                    [t('settings.apiKeys.pathStyleAddressing'), String(created.configs.s3.pathStyle)],
                  ]}
                  copyAllPayload={JSON.stringify(created.configs.s3, null, 2)}
                />
              </TabsContent>
              <TabsContent value="openlist">
                <ConfigRows
                  tab="openlist"
                  rows={[
                    ['URL', created.configs.openlist.url],
                    ['Token', created.configs.openlist.token],
                    ...(created.configs.openlist.pathHint ? [[t('settings.uploadPath'), created.configs.openlist.pathHint]] as Array<[string, string]> : []),
                  ]}
                  copyAllPayload={JSON.stringify(created.configs.openlist, null, 2)}
                />
              </TabsContent>
              <TabsContent value="bearer">
                <ConfigRows
                  tab="bearer"
                  rows={[
                    ['URL', `${created.configs.bearer.url}/api/upload`],
                    ['Header', created.configs.bearer.header],
                    ...(created.configs.bearer.pathHint ? [[t('settings.uploadPath'), created.configs.bearer.pathHint]] as Array<[string, string]> : []),
                  ]}
                  copyAllPayload={JSON.stringify(
                    {
                      url: `${created.configs.bearer.url}/api/upload`,
                      header: created.configs.bearer.header,
                      ...(created.configs.bearer.pathHint ? { uploadPath: created.configs.bearer.pathHint } : {}),
                    },
                    null,
                    2,
                  )}
                />
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
