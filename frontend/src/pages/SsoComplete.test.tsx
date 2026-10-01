// SSO 补充注册页组件测试：
// - 待填档案加载后渲染邮箱/用户名/密码；验证码行按 emailVerificationRequired 门控
// - 「使用提供方信息」一键预填邮箱与用户名（用户可选，不是复用提供方档案）
// - 提交 body（含验证码/邀请码）+ 完成即登录（/me → setAuth → 跳转 /files）
// - 待办令牌失效时显示错误且不渲染表单
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigate = vi.fn();
const apiFetch = vi.fn();

vi.mock('react-i18next', async () => {
  // 用真实 zh 资源解析 key（含 ssoError/ssoComplete 文案），保证断言与界面一致。
  // 必须动态导入：vi.mock 工厂被提升到顶层 import 之前执行，静态导入的 zhCN 在工厂内处于 TDZ。
  const { zhCN } = await import('../lib/i18n/zh');
  // t 必须是稳定引用：假的 useTranslation 每次返回新函数会让依赖 t 的 effect 无限重跑
  const t = (key: string): string => {
    const resolved = key.split('.').reduce<unknown>((node, seg) => {
      if (node && typeof node === 'object') return (node as Record<string, unknown>)[seg];
      return undefined;
    }, zhCN);
    return typeof resolved === 'string' ? resolved : key;
  };
  return { useTranslation: () => ({ t }) };
});

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  };
});

vi.mock('@/components/layout/widgets', () => ({
  ThemeToggle: () => null,
  LanguageSwitcher: () => null,
}));

import SsoComplete from './SsoComplete';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import type { SsoPendingProfile } from '@shared/types';

const TOKEN = 'pending-token-abcdefghijklmnopqrstuvwxyz';

function pendingProfile(overrides: Partial<SsoPendingProfile> = {}): SsoPendingProfile {
  return {
    providerId: 'p1',
    providerName: '公司 SSO',
    kind: 'oidc',
    email: 'idp@test.local',
    emailVerified: false,
    username: 'idp_user',
    displayName: 'IdP User',
    avatarUrl: null,
    emailVerificationRequired: false,
    inviteEnabled: false,
    inviteRequired: false,
    ...overrides,
  };
}

/** 取出补充注册请求体（mock 的调用参数）——用 `in` 收窄，避免内联断言形状 */
function completeBody(): unknown {
  const call = apiFetch.mock.calls.find((c) => c[0] === '/api/auth/sso/complete');
  const init = call?.[1];
  return init && typeof init === 'object' && 'body' in init ? init.body : undefined;
}

/** pending 与 /me 的基础路由；返回是否命中补充注册提交 */
function mockApi(profile: SsoPendingProfile): { completed: () => boolean } {
  let completed = false;
  apiFetch.mockImplementation((path: string) => {
    if (path.startsWith('/api/auth/sso/pending')) return Promise.resolve({ data: profile });
    if (path === '/api/auth/sso/complete') {
      completed = true;
      return Promise.resolve({ data: { user: { id: 'u1' }, quota: {} } });
    }
    if (path === '/api/auth/me') return Promise.resolve({ data: { user: { id: 'u1', username: 'newbie' }, quota: {} } });
    throw new Error(`unexpected apiFetch: ${path}`);
  });
  return { completed: () => completed };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/sso/complete?token=${TOKEN}`]}>
      <SsoComplete />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.setState({ user: null, quota: null, loading: false });
});

describe('SsoComplete 页面', () => {
  it('加载待填档案后渲染邮箱/用户名/密码，免验证码时不渲染验证码行', async () => {
    mockApi(pendingProfile());
    renderPage();

    expect(await screen.findByPlaceholderText('username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
    // i18n mock 不做插值：断言 raw 模板（providerName 由按钮/标题参数传入）
    expect(screen.getByText('已通过 {{name}} 验证身份，请设置本站的邮箱、用户名与密码')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发送验证码' })).toBeNull();
  });

  it('需要邮箱验证时渲染验证码行，提交 body 携带验证码', async () => {
    const api = mockApi(pendingProfile({ emailVerificationRequired: true }));
    renderPage();

    const sendButton = await screen.findByRole('button', { name: '发送验证码' });
    expect(sendButton).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('username'), { target: { value: 'newbie' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'newbie@test.local' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    // 分段输入 6 位：依次填入（i18n mock 不解插值 → 共享同一 raw aria-label）
    const cells = screen.getAllByLabelText('第 {{index}} 位验证码') as HTMLInputElement[];
    cells.forEach((cell, i) => fireEvent.change(cell, { target: { value: String(i + 1) } }));
    fireEvent.click(screen.getByRole('button', { name: '完成注册并登录' }));

    await waitFor(() => {
      expect(api.completed()).toBe(true);
      expect(apiFetch).toHaveBeenCalledWith('/api/auth/sso/complete', {
        method: 'POST',
        body: {
          token: TOKEN,
          username: 'newbie',
          password: 'password123',
          email: 'newbie@test.local',
          emailCode: '123456',
          inviteCode: undefined,
        },
      });
      expect(navigate).toHaveBeenCalledWith('/files', { replace: true });
      expect(useAuth.getState().user?.username).toBe('newbie');
    });
  });

  it('「使用提供方信息」预填邮箱与用户名', async () => {
    mockApi(pendingProfile());
    renderPage();

    await screen.findByPlaceholderText('username');
    fireEvent.click(screen.getByRole('button', { name: '使用 {{name}} 提供的信息' }));

    expect((screen.getByPlaceholderText('username') as HTMLInputElement).value).toBe('idp_user');
    expect((screen.getByPlaceholderText('you@example.com') as HTMLInputElement).value).toBe('idp@test.local');
  });

  it('邀请码开启时渲染分段输入并随提交带上码值', async () => {
    const api = mockApi(pendingProfile({ inviteEnabled: true, inviteRequired: true }));
    renderPage();

    await screen.findByPlaceholderText('username');
    expect(screen.getByText('邀请码')).toBeInTheDocument();
    const cells = screen.getAllByLabelText('邀请码第 {{index}} 位') as HTMLInputElement[];
    expect(cells).toHaveLength(6);
    fireEvent.change(cells[0], { target: { value: 'ab1-cd2ef' } });
    expect(cells.map((c) => c.value).join('')).toBe('AB1CD2');

    fireEvent.change(screen.getByPlaceholderText('username'), { target: { value: 'invitee' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'invitee@test.local' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '完成注册并登录' }));

    await waitFor(() => {
      expect(api.completed()).toBe(true);
      expect(completeBody()).toMatchObject({ inviteCode: 'AB1CD2', token: TOKEN });
    });
  });

  it('验证码行随「提交邮箱是否等于提供方已验证邮箱」变化（与服务端判定一致）', async () => {
    mockApi(pendingProfile({ emailVerificationRequired: false, email: 'verified@idp.test', emailVerified: true }));
    renderPage();

    const emailInput = (await screen.findByPlaceholderText('you@example.com')) as HTMLInputElement;
    // 表单未填邮箱：尚未证明任何邮箱 → 必须显示验证码行
    expect(screen.getByRole('button', { name: '发送验证码' })).toBeInTheDocument();

    // 填成提供方已验证的那个邮箱（大小写无关）→ 免验证码，行消失
    fireEvent.change(emailInput, { target: { value: 'Verified@IdP.test' } });
    expect(screen.queryByRole('button', { name: '发送验证码' })).toBeNull();

    // 改成别的邮箱 → 服务端会要求验证码，前端必须同步显示（否则用户无处输入）
    fireEvent.change(emailInput, { target: { value: 'someone-else@example.com' } });
    expect(await screen.findByRole('button', { name: '发送验证码' })).toBeInTheDocument();
  });

  it('提供方未验证邮箱时验证码行完全跟随服务端判定', async () => {
    // 服务端说需要（站点开启邮箱验证或有 SMTP）→ 填任何邮箱都显示
    mockApi(pendingProfile({ emailVerificationRequired: true, email: 'unverified@idp.test', emailVerified: false }));
    const first = renderPage();
    await screen.findByPlaceholderText('you@example.com');
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'unverified@idp.test' } });
    expect(screen.getByRole('button', { name: '发送验证码' })).toBeInTheDocument();
    first.unmount();

    // 服务端说不需要（站点未开邮箱验证且没有 SMTP）→ 不显示（此时也发不出验证码）
    mockApi(pendingProfile({ emailVerificationRequired: false, email: 'unverified@idp.test', emailVerified: false }));
    renderPage();
    await screen.findByPlaceholderText('you@example.com');
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'unverified@idp.test' } });
    expect(screen.queryByRole('button', { name: '发送验证码' })).toBeNull();
  });

  it('待办令牌失效时显示错误态并提供返回登录入口，不渲染表单', async () => {
    apiFetch.mockRejectedValue(new ApiError(400, 'SSO_PENDING_INVALID', '注册会话已过期'));
    renderPage();

    expect(await screen.findByText('登录会话已失效，请重新发起')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('username')).toBeNull();
  });

  it('提交被拒时显示接口错误且不跳转', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/auth/sso/pending')) return Promise.resolve({ data: pendingProfile() });
      return Promise.reject(new ApiError(409, 'ALREADY_EXISTS', '邮箱已被注册'));
    });
    renderPage();

    await screen.findByPlaceholderText('username');
    fireEvent.change(screen.getByPlaceholderText('username'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'dup@test.local' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '完成注册并登录' }));

    expect(await screen.findByText('邮箱已被注册')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
