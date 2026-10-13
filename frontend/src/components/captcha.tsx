// 人机验证客户端小部件（双提供方，显式渲染）
//
// Cloudflare Turnstile：脚本 challenges.cloudflare.com/turnstile/v0/api.js?render=explicit；
// Google reCAPTCHA（v2/v3 经典版）：www.google.com/recaptcha/api.js?render=explicit。
// 主题跟随站点、语言跟随 i18n。脚本仅注入一次；token 单次有效——成功回调后由调用方消费，
// 过期/失败调 reset() 重新出题。安全边界：脚本 URL 固定常量（站点密钥经 render 参数传入，
// 不参与任何字符串拼接）。
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface TurnstileApi {
  render: (el: HTMLElement, params: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

interface GrecaptchaApi {
  render: (el: HTMLElement, params: Record<string, unknown>) => number;
  reset: (widgetId?: number) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    grecaptcha?: GrecaptchaApi;
    onCaptchaScriptLoad?: () => void;
  }
}

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const RECAPTCHA_SCRIPT = 'https://www.google.com/recaptcha/api.js?render=explicit';

type ScriptKind = 'turnstile' | 'recaptcha';

const scriptState: Record<ScriptKind, 'idle' | 'loading' | 'ready'> = { turnstile: 'idle', recaptcha: 'idle' };
const waiting: Partial<Record<ScriptKind, Array<() => void>>> = {};

function ensureScript(kind: ScriptKind): void {
  if (scriptState[kind] === 'ready') {
    for (const fn of (waiting[kind] ??= []).splice(0)) fn();
    return;
  }
  if (scriptState[kind] === 'loading') return;
  scriptState[kind] = 'loading';
  const flush = () => {
    scriptState[kind] = 'ready';
    for (const fn of (waiting[kind] ??= []).splice(0)) fn();
  };
  const script = document.createElement('script');
  script.src = kind === 'turnstile' ? TURNSTILE_SCRIPT : RECAPTCHA_SCRIPT;
  script.async = true;
  script.defer = true;
  // 显式渲染模式：脚本加载完成即回调（render=explicit 不触发 onload 全局参数，
  // 必须监听 script.onload —— 此前缺失导致 render 永不执行、小部件空白）
  script.onload = flush;
  script.onerror = () => {
    // 加载失败回到 idle：下次渲染重试注入
    scriptState[kind] = 'idle';
  };
  document.head.appendChild(script);
}

export interface CaptchaWidgetProps {
  provider: 'turnstile' | 'recaptcha';
  siteKey: string;
  action: string;
  /** token 就绪（每次成功挑战回调一次；消费后请调用 reset） */
  onToken: (token: string) => void;
  /** 受控清空：外部 token 被消费/提交失败时触发内部 reset */
  resetSignal?: number;
  className?: string;
}

/** 单一小部件渲染器：provider 决定脚本与渲染参数 */
export function CaptchaWidget({ provider, siteKey, action, onToken, resetSignal, className }: CaptchaWidgetProps) {
  const { t, i18n } = useTranslation();
  const holderId = useId();
  const holderRef = useRef<HTMLDivElement | null>(null);
  const turnstileIdRef = useRef<string | null>(null);
  const recaptchaIdRef = useRef<number | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [failed, setFailed] = useState(false);
  const lang = i18n.language === 'zh' ? 'zh-cn' : i18n.language === 'en' ? 'en' : 'auto';
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    const cleanup = () => {
      if (provider === 'turnstile' && turnstileIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(turnstileIdRef.current);
        turnstileIdRef.current = null;
      }
    };
    const render = () => {
      if (cancelled || !holderRef.current) return;
      setFailed(false);
      if (provider === 'turnstile') {
        if (!window.turnstile) return;
        cleanup();
        turnstileIdRef.current = window.turnstile.render(holderRef.current, {
          sitekey: siteKey,
          action,
          theme: dark ? 'dark' : 'light',
          language: lang,
          // 不覆盖 appearance：可见性由 Cloudflare 面板的「小组件模式」（托管/非交互式/不可见）决定
          'response-field': false,
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(''),
          'error-callback': () => {
            setFailed(true);
            onTokenRef.current('');
            return true;
          },
        });
      } else {
        if (!window.grecaptcha) return;
        if (recaptchaIdRef.current !== null) window.grecaptcha.reset(recaptchaIdRef.current);
        recaptchaIdRef.current = window.grecaptcha.render(holderRef.current, {
          sitekey: siteKey,
          theme: dark ? 'dark' : 'light',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(''),
          'error-callback': () => {
            setFailed(true);
            onTokenRef.current('');
            return true;
          },
        });
      }
    };
    ensureScript(provider);
    // api.js 加载完成与 turnstile/grecaptcha 命名空间就绪之间存在间隙：轮询等待就绪后渲染
    // （render=explicit 不回调 onload 全局参数，script.onload 时机偏早，静默返回会让小部件永远空白）
    let tries = 0;
    const tryRender = () => {
      if (cancelled) return;
      const api = provider === 'turnstile' ? window.turnstile : window.grecaptcha;
      if (api) {
        render();
        return;
      }
      if (++tries > 40) return;
      setTimeout(tryRender, 250);
    };
    tryRender();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [provider, siteKey, action, lang, dark]);

  // 外部 resetSignal 变化 → 重置出题并清空 token
  useEffect(() => {
    if (resetSignal === undefined) return;
    if (provider === 'turnstile' && turnstileIdRef.current !== null && window.turnstile) {
      window.turnstile.reset(turnstileIdRef.current);
    }
    if (provider === 'recaptcha' && recaptchaIdRef.current !== null && window.grecaptcha) {
      window.grecaptcha.reset(recaptchaIdRef.current);
    }
    onTokenRef.current('');
  }, [resetSignal, provider]);

  if (failed) {
    return (
      <p className={className ?? 'text-xs text-destructive'} role="alert">
        {t('common.captchaFailed')}
      </p>
    );
  }
  return <div id={holderId} ref={holderRef} className={className} />;
}


/**
 * 多次请求门控 hook：每次 freshToken() 内部 reset 小部件并等待新 token 回调
 * （Turnstile interaction-only 模式通常自动通过，无需用户交互；需要交互时小部件自行展开）。
 * element 渲染在调用方 JSX 中（隐藏在页面上的固定位置）。
 */
export function useCaptchaGate(props: {
  provider: 'turnstile' | 'recaptcha';
  siteKey: string;
  action: string;
  enabled: boolean;
}): { token: string; freshToken: () => Promise<string>; reset: () => void; element: ReactNode } {
  const { provider, siteKey, action, enabled } = props;
  const [token, setToken] = useState('');
  const [resetCount, setResetCount] = useState(0);
  const resolverRef = useRef<((token: string) => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onToken = (t: string) => {
    setToken(t);
    if (t && resolverRef.current) {
      resolverRef.current(t);
      resolverRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    }
  };

  const reset = () => {
    setToken('');
    setResetCount((n) => n + 1);
    return new Promise<string>((resolve, reject) => {
      if (!enabled) return resolve('');
      resolverRef.current = resolve;
      timerRef.current = setTimeout(() => {
        resolverRef.current = null;
        reject(new Error('captcha_timeout'));
      }, 30_000);
    });
  };

  const freshToken = async (): Promise<string> => {
    if (!enabled) return '';
    const current = await reset();
    return current;
  };

  const element = enabled ? (
    <CaptchaWidget provider={provider} siteKey={siteKey} action={action} onToken={onToken} resetSignal={resetCount} className="sr-only" />
  ) : null;

  return { token, freshToken, reset, element };
}
