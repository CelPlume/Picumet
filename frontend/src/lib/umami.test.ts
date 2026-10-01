// Umami tracker：注入器（未启用不注入 / 白名单属性 / 幂等）与事件上报（track 转发 / 事件名截断 / 静默 no-op）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initUmami, trackUmami, resetUmamiForTest, UMAMI_EVENT_NAME_MAX, type UmamiConfig } from './umami';

const VALID_UUID = '94db1cb1-74f4-4a40-ad6c-962362670409';

const cfg: UmamiConfig = {
  enabled: true,
  scriptUrl: 'https://umami.example.com/script.js',
  websiteId: VALID_UUID,
};

function injectedScripts(): HTMLScriptElement[] {
  return Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[data-website-id]'));
}

beforeEach(() => {
  resetUmamiForTest();
  injectedScripts().forEach((s) => s.remove());
  delete window.umami;
});

describe('initUmami', () => {
  it('未启用 / 配置缺失时不注入', () => {
    initUmami(undefined);
    initUmami(null);
    initUmami({ ...cfg, enabled: false });
    initUmami({ ...cfg, scriptUrl: '' });
    expect(injectedScripts()).toHaveLength(0);
  });

  it('按白名单属性注入脚本（src + data-website-id + defer）', () => {
    initUmami(cfg);
    const [script] = injectedScripts();
    expect(script).toBeTruthy();
    expect(script.src).toBe('https://umami.example.com/script.js');
    expect(script.getAttribute('data-website-id')).toBe(VALID_UUID);
    expect(script.defer).toBe(true);
  });

  it('可选属性只注入白名单六个；未知键（如 data-before-send）被忽略', () => {
    // 攻击面探测：配置对象里多出的键绝不能落到脚本上（data-before-send 指向全局函数名）
    initUmami({
      ...cfg,
      hostUrl: 'https://stats.example.com',
      domains: 'example.com',
      performance: true,
      excludeSearch: true,
      doNotTrack: true,
    } as unknown as UmamiConfig & { beforeSend: string });
    const [script] = injectedScripts();
    const attrs = Array.from(script.attributes)
      .map((a) => a.name)
      .sort();
    expect(attrs).toEqual(
      ['src', 'defer', 'data-website-id', 'data-host-url', 'data-domains', 'data-performance', 'data-exclude-search', 'data-do-not-track'].sort(),
    );
    expect(script.hasAttribute('data-before-send')).toBe(false);
  });

  it('幂等：重复调用只注入一次', () => {
    initUmami(cfg);
    initUmami(cfg);
    expect(injectedScripts()).toHaveLength(1);
  });
});

describe('trackUmami', () => {
  it('tracker 未就绪时静默 no-op（不抛错）', () => {
    expect(() => trackUmami('file_download', { name: 'a.txt', size: 3 })).not.toThrow();
  });

  it('转发事件名与数据；事件名按官方上限截断到 50 字符', () => {
    const track = vi.fn();
    window.umami = { track };
    const long = 'e'.repeat(60);
    trackUmami(long, { size: 3 });
    expect(track).toHaveBeenCalledWith(long.slice(0, UMAMI_EVENT_NAME_MAX), { size: 3 });
  });

  it('无数据事件只传事件名', () => {
    const track = vi.fn();
    window.umami = { track };
    trackUmami('copy_link');
    expect(track).toHaveBeenCalledWith('copy_link');
  });

  it('空事件名不调用（截断后为空）', () => {
    const track = vi.fn();
    window.umami = { track };
    trackUmami('');
    expect(track).not.toHaveBeenCalled();
  });
});
