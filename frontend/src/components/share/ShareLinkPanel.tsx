// 分享链接面板（分享页与分享管理共用）：
// 二维码 + 链接文本 + 「附带密码」开关 + 复制链接 + 查看密码 + 复制分享文案。
// 开关打开时，二维码与复制出的链接都带 `?password=<明文>`，对方打开即直进无需手输。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { useEffect } from 'react';
import { Copy, Eye, KeyRound } from 'lucide-react';
import { DropdownItem } from '@/components/ui/dropdown';
import { Switch } from '@/components/ui/core';
import { toast } from '@/components/ui/toast';

/** 本地生成二维码（不依赖第三方服务） */
function Qr({ data }: { data: string }) {
  const { t } = useTranslation();
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    void QRCode.toDataURL(data, { width: 180, margin: 2 })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [data]);
  if (!src) return <div className="h-[160px] w-[160px] animate-pulse rounded-md bg-muted" aria-label={t('sharePage.qrLoading')} />;
  return <img src={src} alt="QR" className="rounded-md border" />;
}

export interface ShareLinkPanelProps {
  /** 分享 ID（用于拼链接） */
  id: string;
  /** 已知的访问密码（创建者视角或访客刚输入过）；未知时隐藏密码相关控件 */
  password?: string;
  /** 分享者用户名（用于文案） */
  user: string;
  /** 分享标题 / 文件名 / N 个项目 */
  title: string;
  /** 点击任一菜单项后关闭下拉 */
  onClose: () => void;
}

export function ShareLinkPanel({ id, password, user, title, onClose }: ShareLinkPanelProps) {
  const { t } = useTranslation();
  const [withPassword, setWithPassword] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const base = `${window.location.origin}/share/${id}`;
  const link = withPassword && password ? `${base}?password=${encodeURIComponent(password)}` : base;
  const message = password && withPassword
    ? t('share.copyTextTemplate', { user, title, url: link, password })
    : t('share.copyTextNoPassword', { user, title, url: link });

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('success', done);
    } catch {
      toast('error', t('common.operationFailed'));
    }
  };

  return (
    <>
      <div className="flex justify-center py-1">
        <Qr data={link} />
      </div>
      <div className="px-2 pb-1">
        <p className="truncate text-[11px] text-muted-foreground" title={link}>
          {link}
        </p>
        {password && (
          <label className="mt-1.5 flex cursor-pointer items-center justify-between gap-2 text-xs">
            <span>{t('share.includePassword')}</span>
            <Switch checked={withPassword} onChange={setWithPassword} />
          </label>
        )}
      </div>
      {/* 「复制链接」按用户要求直接复制整段文案（分享者 + 标题 + 链接，勾选附带密码时含密码行） */}
      <DropdownItem
        icon={<Copy className="h-4 w-4" />}
        onClick={() => {
          onClose();
          void copy(message, t('share.copyTextDone'));
        }}
      >
        {t('share.copyLink')}
      </DropdownItem>
      {password &&
        (revealed ? (
          <DropdownItem
            icon={<KeyRound className="h-4 w-4 shrink-0" />}
            onClick={() => {
              onClose();
              void copy(password, t('share.passwordCopied'));
            }}
          >
            <span className="shrink-0 text-xs text-muted-foreground">{t('share.password')}</span>
            <span className="min-w-0 flex-1 font-mono text-xs break-all select-all">{password}</span>
          </DropdownItem>
        ) : (
          <DropdownItem icon={<Eye className="h-4 w-4" />} onClick={() => setRevealed(true)}>
            {t('share.viewPassword')}
          </DropdownItem>
        ))}
    </>
  );
}
