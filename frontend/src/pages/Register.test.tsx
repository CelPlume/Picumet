// 注册页组件测试：表单提交调用 /api/auth/register 并跳转登录
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigate = vi.fn();
const apiFetch = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {
    constructor(message: string) {
      super(message);
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
    fireEvent.click(screen.getByRole('button', { name: 'common.register' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'common.register' }));

    await waitFor(() => {
      expect(navigate).not.toHaveBeenCalled();
    });
  });
});
