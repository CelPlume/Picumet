// 注册页组件测试：表单提交调用 /api/auth/register 并跳转登录
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigate = vi.fn();
const apiFetch = vi.fn();

vi.mock('react-i18next', async () => {
  // Register 文案已 i18n 化（cac54b4）：mock 用真实 zh 资源解析 key，使断言文案与界面一致。
  // 此处必须用动态导入：vi.mock 工厂被提升到文件顶层 import 之前执行，
  // 静态导入的 zhCN 在工厂内处于 TDZ，无法引用（vitest 既有约束）。
  const { zhCN } = await import('../lib/i18n/zh');
  return {
    useTranslation: () => ({
      t: (key: string) => {
        const resolved = key.split('.').reduce<unknown>((node, seg) => {
          if (node && typeof node === 'object') return (node as Record<string, unknown>)[seg];
          return undefined;
        }, zhCN);
        return typeof resolved === 'string' ? resolved : key;
      },
    }),
  };
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

import Register from './Register';
import { ApiError } from '@/lib/api';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Register 页面', () => {
  it('渲染用户名/邮箱/密码输入框', () => {
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );
    expect(screen.getByPlaceholderText('username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
  });

  it('提交时调用 /api/auth/register 并跳转到登录页', async () => {
    apiFetch.mockResolvedValueOnce({ user: { id: 'u1' }, message: '注册成功' });
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText('username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@test.local' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/auth/register', {
        method: 'POST',
        body: { username: 'alice', password: 'password123', email: 'alice@test.local' },
      });
      expect(navigate).toHaveBeenCalledWith('/login?registered=1');
    });
  });

  it('接口返回错误时显示错误信息，不跳转', async () => {
    apiFetch.mockRejectedValueOnce(
      Object.assign(new Error('用户名已被占用'), { name: 'ApiError' })
    );
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText('username'), { target: { value: 'taken' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'taken@test.local' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    await waitFor(() => {
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  it('邮箱为空时点击发送验证码直接提示错误，不请求接口', async () => {
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    expect(await screen.findByText('请输入邮箱')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('发送验证码成功后进入倒计时并提示', async () => {
    apiFetch.mockResolvedValueOnce({ message: 'ok' });
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@test.local' } });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/auth/register/send-otp', {
        method: 'POST',
        body: { email: 'alice@test.local' },
      });
      // 倒计时启动后按钮切换为秒数并禁用（toast 文案不在测试挂载树内）
      expect(screen.getByRole('button', { name: /60s/ })).toBeDisabled();
    });
  });

  it('发送验证码失败时显示接口错误', async () => {
    apiFetch.mockRejectedValueOnce(new ApiError(429, 'rate_limited', '发送过于频繁'));
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@test.local' } });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    // 污染环境下（前序用例泄漏的倒计时定时器）错误段落在 ~1.1s 才渲染，放宽等待
    expect(await screen.findByText('发送过于频繁', {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
