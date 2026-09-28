// LAB：审计日志策略单测——等级语义（all/essential/security）、项目分组过滤、未知动作保守归组
import { describe, it, expect } from 'vitest';
import { shouldLogAction, auditActionGroup, AUDIT_LOG_GROUPS, type AuditLogGroup } from '../src/db/repos/system';

const policy = (level: string, groups: AuditLogGroup[] = [...AUDIT_LOG_GROUPS]) => ({ level, groups, at: 0 }) as Parameters<typeof shouldLogAction>[0];

describe('审计日志策略', () => {
  it('all：全部记录', () => {
    const p = policy('all');
    for (const a of ['upload', 'download', 'login', 'share', 'review', 'delete', 'download_failed']) {
      expect(shouldLogAction(p, a)).toBe(true);
    }
  });

  it('essential：成功读/下载不记，失败恒记', () => {
    const p = policy('essential');
    expect(shouldLogAction(p, 'download')).toBe(false);
    expect(shouldLogAction(p, 'gallery_download')).toBe(false);
    expect(shouldLogAction(p, 'read')).toBe(false);
    expect(shouldLogAction(p, 'download_failed')).toBe(true);
    expect(shouldLogAction(p, 'login_failed')).toBe(true);
    expect(shouldLogAction(p, 'upload')).toBe(true);
    expect(shouldLogAction(p, 'login')).toBe(true);
  });

  it('security：仅认证/管理/失败', () => {
    const p = policy('security');
    expect(shouldLogAction(p, 'login')).toBe(true);
    expect(shouldLogAction(p, 'register')).toBe(true);
    expect(shouldLogAction(p, 'review')).toBe(true);
    expect(shouldLogAction(p, 'visibility_change')).toBe(true);
    expect(shouldLogAction(p, 'login_failed')).toBe(true);
    expect(shouldLogAction(p, 'download')).toBe(false);
    expect(shouldLogAction(p, 'upload')).toBe(false);
    expect(shouldLogAction(p, 'share')).toBe(false);
  });

  it('项目（分组）开关：关闭 download 后该组动作一律不记（失败组独立）', () => {
    const p = policy('all', AUDIT_LOG_GROUPS.filter((g) => g !== 'download'));
    expect(shouldLogAction(p, 'download')).toBe(false);
    expect(shouldLogAction(p, 'download_link')).toBe(false);
    // download_failed 属 failure 组（横切），不受 download 关闭影响
    expect(shouldLogAction(p, 'download_failed')).toBe(true);
    expect(shouldLogAction(p, 'upload')).toBe(true);
  });

  it('分组映射：*_failed 横切入 failure；未知动作保守归 admin', () => {
    expect(auditActionGroup('download_failed')).toBe('failure');
    expect(auditActionGroup('login_failed')).toBe('failure');
    expect(auditActionGroup('login')).toBe('auth');
    expect(auditActionGroup('upload')).toBe('upload');
    expect(auditActionGroup('share')).toBe('share');
    expect(auditActionGroup('review')).toBe('admin');
    expect(auditActionGroup('some_future_action')).toBe('admin');
  });
});
