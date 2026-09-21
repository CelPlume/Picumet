// 网关密钥管理（对象存储中转 / PicGo / WebDAV / S3 / OpenList 兼容）
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Copy, Trash2, Check } from 'lucide-react';
import { Card, Button, Input, Label, EmptyState, Badge, Dialog, Switch, ConfirmDialog } from '@/components/ui/core';
import { FormCardSkeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/toast';
import { apiFetch, ApiError } from '@/lib/api';
import { timeAgo } from '@/lib/utils';

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
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);
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
    if (!name) return toast('error', '请输入名称');
    try {
      const res = await apiFetch<CreatedKey>('/api/keys', {
        method: 'POST',
        body: { name, permissions, protocols, uploadPath: uploadPath || '/uploads' },
      });
      setCreated(res.data);
      setShowCreate(false);
      await load();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : '创建失败');
    }
  };

  const revoke = async (id: string) => {
    try {
      await apiFetch(`/api/keys/${id}`, { method: 'DELETE' });
      toast('success', t('settings.keyRevoked'));
      await load();
    } catch {
      toast('error', '操作失败');
    }
    setConfirmRevoke(null);
  };

  const togglePerm = (p: string) =>
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const toggleProto = (p: string) =>
    setProtocols((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('settings.apiKeys')}</h2>
        <Button onClick={() => setShowCreate(true)}>
          <KeyRound className="h-4 w-4" /> {t('settings.createKey')}
        </Button>
      </div>

      {loading ? (
        <FormCardSkeleton />
      ) : keys.length === 0 ? (
        <EmptyState
          title={t('settings.noKeys')}
          description={t('settings.noKeysDesc')}
          action={<Button onClick={() => setShowCreate(true)}><KeyRound className="h-4 w-4" /> {t('settings.createKey')}</Button>}
        />
      ) : (
        <div className="space-y-3">
          {keys.map((k) => (
            <Card key={k.id} className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <KeyRound className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{k.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{k.keyId.slice(0, 12)}...{k.keyId.slice(-6)}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {k.permissions.map((p) => <Badge key={p} variant="secondary">{p}</Badge>)}
                    {k.protocols.map((p) => <Badge key={p} variant="outline">{p}</Badge>)}
                    {k.status !== 'active' && <Badge variant="destructive">{k.status}</Badge>}
                  </div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <p>{t('settings.lastUsed')}: {k.lastUsedAt ? timeAgo(k.lastUsedAt) : t('settings.neverUsed')}</p>
                  <button onClick={() => setConfirmRevoke(k.id)} className="mt-1 flex items-center gap-1 rounded-md px-2 py-1 text-destructive hover:bg-destructive/10">
                    <Trash2 className="h-3.5 w-3.5" /> {t('settings.revoke')}
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
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
        title="✅ 密钥已创建"
        footer={<Button onClick={() => setCreated(null)}>{t('common.close')}</Button>}
      >
        {created && (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              ⚠️ {t('settings.secretWarning')}
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
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">📦 WebDAV 配置</p>
              <pre className="overflow-x-auto text-xs">
{`URL: ${created.configs.webdav.url}
用户名: ${created.configs.webdav.username}
密码: ${created.configs.webdav.password}
customUrl(公开直链域名): ${created.configs.webdav.customUrlHint ?? ''}${created.configs.webdav.webpathHint ? `\nwebpath: ${created.configs.webdav.webpathHint}` : ''}`}
              </pre>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(JSON.stringify(created.configs.webdav), 'webdav')}>
                {copyState === 'webdav' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} 复制
              </Button>
            </div>
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">🪣 {t('settings.s3')}（S3 兼容网关）</p>
              <pre className="overflow-x-auto text-xs">
{`endpoint: ${created.configs.s3.endpoint}
region: ${created.configs.s3.region}
AccessKeyId: ${created.configs.s3.accessKeyId}
SecretAccessKey: ${created.configs.s3.secretAccessKey}
bucket: ${created.configs.s3.bucketHint ?? ''}
路径式寻址(forcePathStyle/pathStyleAccess): ${created.configs.s3.pathStyle}`}
              </pre>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(JSON.stringify(created.configs.s3), 's3')}>
                {copyState === 's3' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} 复制
              </Button>
            </div>
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">🟦 {t('settings.openlist')}（AList 协议）</p>
              <pre className="overflow-x-auto text-xs">
{`URL: ${created.configs.openlist.url}
Token: ${created.configs.openlist.token}`}
              </pre>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(JSON.stringify(created.configs.openlist), 'openlist')}>
                {copyState === 'openlist' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} 复制
              </Button>
            </div>
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">🔧 自定义 API</p>
              <pre className="overflow-x-auto text-xs">
{`URL: ${created.configs.bearer.url}/api/upload
Header: ${created.configs.bearer.header}`}
              </pre>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => copy(created.configs.bearer.header, 'bearer')}>
                {copyState === 'bearer' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} 复制
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => confirmRevoke && void revoke(confirmRevoke)}
        title="撤销密钥"
        message="确定撤销该密钥？使用此密钥的客户端将立即失去访问权限，该操作不可恢复。"
      />
    </div>
  );
}
