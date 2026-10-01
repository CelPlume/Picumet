// 第三方登录入口（登录页 / 注册页共用）：来源来自公开设置 `site.sso`，未启用或没有来源时不渲染。
// 点击即整页跳转 `/api/auth/sso/<id>/start`——OAuth 授权必须离开 SPA（跨域跳转到提供方）。
import { useTranslation } from 'react-i18next';
import { Chrome, Github, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/core';
import { useSite } from '@/stores/site';
import type { SsoProviderKind } from '@shared/types';

const ICONS: Record<SsoProviderKind, typeof Chrome> = {
  google: Chrome,
  github: Github,
  oidc: ShieldCheck,
};

/**
 * 回调错误码 → i18n key。后端只回错误码，文案由前端提供；
 * 未知码归入通用文案（避免出现裸 key）。
 */
export function ssoErrorKey(code: string): string {
  switch (code) {
    case 'SSO_DISABLED':
      return 'auth.ssoError.disabled';
    case 'SSO_CANCELLED':
      return 'auth.ssoError.cancelled';
    case 'SSO_STATE_INVALID':
    case 'SSO_PENDING_INVALID':
      return 'auth.ssoError.session';
    case 'SSO_PROVIDER_NOT_FOUND':
    case 'SSO_ACCOUNT_DISABLED':
    case 'REGISTRATION_DISABLED':
      return 'auth.ssoError.unavailable';
    case 'SSO_ID_TOKEN_INVALID':
    case 'SSO_NONCE_MISMATCH':
      return 'auth.ssoError.verify';
    case 'SSO_TOKEN_FAILED':
    case 'SSO_PROFILE_FAILED':
    case 'SSO_PROFILE_INVALID':
    case 'SSO_DISCOVERY_FAILED':
    case 'SSO_DISCOVERY_MISMATCH':
    case 'SSO_DISCOVERY_INVALID':
    case 'SSO_JWKS_FAILED':
    case 'SSO_UPSTREAM_REDIRECT':
      return 'auth.ssoError.upstream';
    case 'SSO_SECRET_UNAVAILABLE':
      return 'auth.ssoError.config';
    default:
      return 'auth.ssoError.generic';
  }
}

export function SsoButtons() {
  const { t } = useTranslation();
  const sso = useSite((s) => s.sso);
  if (!sso?.enabled || sso.providers.length === 0) return null;
  return (
    <div className="space-y-2">
      {sso.providers.map((p) => {
        const Icon = ICONS[p.kind] ?? ShieldCheck;
        return (
          <a key={p.id} href={`/api/auth/sso/${p.id}/start`} className="block">
            <Button type="button" variant="outline" className="w-full py-2 font-medium">
              <Icon className="h-4 w-4" />
              {t('auth.ssoContinue', { name: p.name })}
            </Button>
          </a>
        );
      })}
    </div>
  );
}
