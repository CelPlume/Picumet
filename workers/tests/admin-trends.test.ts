// 趋势聚合（GET /api/admin/dashboard/trends）：三指标分组计数、零填充、四种粒度桶边界、
// 区间 [from, to) 语义、参数与桶数上限校验、管理员鉴权，以及登录/下载埋点落库
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContext, initSeeded, request, json, registerAndLogin, getCsrf, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie = '';
let adminId = '';
let seedFileId = '';

const HOUR = 3600_000;
const DAY = 86_400_000;
let seq = 0;

beforeAll(async () => {
  ctx = createTestContext();
  await initSeeded(ctx);

  const login = await request(ctx, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  expect(login.status).toBe(200);
  const loginBody = await json<{ data: { user: { id: string } } }>(login);
  adminId = loginBody.data.user.id;
  adminCookie = (login.headers.get('set-cookie') ?? '').match(/auth_token=([^;]+)/)?.[0] ?? '';
  // node:sqlite 行是 unknown；此查询固定返回种子文件的一行 id
  const seedRow = ctx.db.prepare(`SELECT id FROM file_metadata WHERE type = 'file' LIMIT 1`).get() as
    | { id: string }
    | undefined;
  seedFileId = seedRow?.id ?? '';
});

/** 直插访问日志：需要精确控制 created_at，绕开 LogRepo.create（其时间取 Date.now()） */
function insertLog(action: string, createdAt: number): void {
  ctx.db
    .prepare(
      `INSERT INTO access_logs (id, user_id, action, path, metadata, ip_address, user_agent, bytes_transferred, status_code, created_at)
       VALUES (?, ?, ?, '/trend.txt', NULL, NULL, NULL, 0, 200, ?)`
    )
    .run(`trend-log-${++seq}`, adminId, action, createdAt);
}

/** 直插分享行：shares 趋势按 shares.created_at 数新建分享 */
function insertShare(createdAt: number): void {
  ctx.db
    .prepare(`INSERT INTO shares (id, file_id, creator_id, created_at, status) VALUES (?, ?, ?, ?, 'active')`)
    .run(`trend-share-${++seq}`, seedFileId, adminId, createdAt);
}

function countLogs(where: string, ...params: string[]): number {
  // node:sqlite 行是 unknown；固定聚合查询返回一行 c 列
  const row = ctx.db.prepare(`SELECT COUNT(*) AS c FROM access_logs WHERE ${where}`).get(...params) as {
    c: number;
  };
  return Number(row.c);
}

interface TrendBucket {
  t: number;
  count: number;
}
interface TrendPayload {
  metric: string;
  granularity: string;
  buckets: TrendBucket[];
}
interface TrendEnvelope {
  data?: TrendPayload;
  error?: { code: string; message: string };
}

async function getTrends(query: string, cookie: string = adminCookie): Promise<{ status: number; body: TrendEnvelope }> {
  const res = await request(ctx, `/api/admin/dashboard/trends?${query}`, cookie ? { cookie } : {});
  return { status: res.status, body: await json<TrendEnvelope>(res) };
}

async function uploadFile(cookie: string, fileName: string, content: string): Promise<{ id: string }> {
  const csrf = await getCsrf(ctx, cookie);
  const bytes = new TextEncoder().encode(content);
  const initRes = await request(ctx, '/api/files/upload-session', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { path: '/', fileName, fileSize: bytes.byteLength, mimeType: 'text/plain' },
  });
  const initBody = await json<{ data: { sessionId: string } }>(initRes);
  await request(ctx, `/api/files/upload/raw/${initBody.data.sessionId}`, {
    method: 'PUT',
    cookie,
    headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf },
    body: content,
  });
  const completeRes = await request(ctx, '/api/files/upload-complete', {
    method: 'POST',
    cookie,
    headers: { 'X-CSRF-Token': csrf },
    body: { sessionId: initBody.data.sessionId, etag: 'etag' },
  });
  const completeBody = await json<{ data: { file: { id: string } } }>(completeRes);
  return completeBody.data.file;
}

describe('趋势聚合', () => {
  it('downloads：按天分桶计数，只统计 action=download', async () => {
    const from = Date.UTC(2026, 0, 5); // 2026-01-05 00:00 UTC
    const to = Date.UTC(2026, 0, 8);
    insertLog('download', from + 10 * HOUR);
    insertLog('download', from + 23 * HOUR + 59 * 60_000);
    insertLog('download', from + DAY + 23 * HOUR);
    insertLog('download', from + 2 * DAY + 30_000);
    insertLog('login', from + 11 * HOUR); // 其他动作不得混入
    insertLog('download_link', from + 12 * HOUR);
    insertLog('download_failed', from + 13 * HOUR);

    const { status, body } = await getTrends(`metric=downloads&granularity=day&from=${from}&to=${to}`);
    expect(status).toBe(200);
    expect(body.data?.metric).toBe('downloads');
    expect(body.data?.granularity).toBe('day');
    expect(body.data?.buckets).toEqual([
      { t: from, count: 2 },
      { t: from + DAY, count: 1 },
      { t: from + 2 * DAY, count: 1 },
    ]);
  });

  it('logins：只统计登录成功，login_failed 不计', async () => {
    const from = Date.UTC(2026, 1, 2);
    const to = Date.UTC(2026, 1, 4);
    insertLog('login', from + HOUR);
    insertLog('login', from + DAY + 5 * HOUR);
    insertLog('login_failed', from + 2 * HOUR);

    const { status, body } = await getTrends(`metric=logins&granularity=day&from=${from}&to=${to}`);
    expect(status).toBe(200);
    expect(body.data?.buckets).toEqual([
      { t: from, count: 1 },
      { t: from + DAY, count: 1 },
    ]);
  });

  it('shares：按 shares.created_at 数新建分享（各状态都算创建事件）', async () => {
    const from = Date.UTC(2026, 2, 1);
    const to = Date.UTC(2026, 2, 3);
    insertShare(from + 3 * HOUR);
    insertShare(from + DAY + 3 * HOUR);
    insertShare(to + 3 * HOUR); // 恰在 to 之后 → 不计

    const { status, body } = await getTrends(`metric=shares&granularity=day&from=${from}&to=${to}`);
    expect(status).toBe(200);
    expect(body.data?.metric).toBe('shares');
    expect(body.data?.buckets).toEqual([
      { t: from, count: 1 },
      { t: from + DAY, count: 1 },
    ]);
  });

  it('share_visits：沿用 action=share 的分享访问计数', async () => {
    const from = Date.UTC(2026, 2, 10);
    const to = Date.UTC(2026, 2, 11);
    insertLog('share', from + HOUR);
    insertLog('share', from + 2 * HOUR);
    insertLog('gallery_password_verify', from + 3 * HOUR);

    const { status, body } = await getTrends(`metric=share_visits&granularity=day&from=${from}&to=${to}`);
    expect(status).toBe(200);
    expect(body.data?.buckets).toEqual([{ t: from, count: 2 }]);
  });

  it('零填充：空区间返回连续全 0 桶（hour/day/month）', async () => {
    const dayFrom = Date.UTC(2030, 5, 1);
    const dayTo = Date.UTC(2030, 5, 6);
    const dayRes = await getTrends(`metric=downloads&granularity=day&from=${dayFrom}&to=${dayTo}`);
    expect(dayRes.body.data?.buckets).toEqual(
      [0, 1, 2, 3, 4].map((i) => ({ t: dayFrom + i * DAY, count: 0 }))
    );

    const hourFrom = Date.UTC(2030, 5, 1, 7, 15);
    const hourTo = hourFrom + 3 * HOUR;
    const hourRes = await getTrends(`metric=logins&granularity=hour&from=${hourFrom}&to=${hourTo}`);
    // [from,to) = 07:15–10:15：7 点桶（含 07:15–08:00）到 10 点桶（含 10:00–10:15）共 4 个
    expect(hourRes.body.data?.buckets).toEqual(
      [0, 1, 2, 3].map((i) => ({ t: Date.UTC(2030, 5, 1, 7) + i * HOUR, count: 0 }))
    );

    const monthFrom = Date.UTC(2031, 0, 15);
    const monthTo = Date.UTC(2031, 4, 2);
    const monthRes = await getTrends(`metric=shares&granularity=month&from=${monthFrom}&to=${monthTo}`);
    expect(monthRes.body.data?.buckets).toEqual(
      [0, 1, 2, 3, 4].map((i) => ({ t: Date.UTC(2031, i, 1), count: 0 }))
    );
  });

  it('hour/day/week/month 桶边界正确（week 以周一为周首）', async () => {
    // hour：边界落在整点。用 2026-02-10（周二），其周桶 02-09 与后面 week 用例的 04-06 周桶互不重叠，
    // 避免同文件用例间的数据泄漏（insertLog 直插库，用例间不回滚）。
    const hFrom = Date.UTC(2026, 1, 10, 9);
    insertLog('download', hFrom + 59 * 60_000 + 59_000 + 999); // 9:59:59.999 → 9 点桶
    insertLog('download', hFrom + HOUR); // 10:00:00.000 → 10 点桶
    const hourRes = await getTrends(`metric=downloads&granularity=hour&from=${hFrom}&to=${hFrom + 3 * HOUR}`);
    expect(hourRes.body.data?.buckets).toEqual([
      { t: hFrom, count: 1 },
      { t: hFrom + HOUR, count: 1 },
      { t: hFrom + 2 * HOUR, count: 0 },
    ]);

    // day：边界落在 UTC 0 点
    const dFrom = Date.UTC(2026, 3, 20);
    insertLog('download', dFrom + DAY - 1); // 23:59:59.999 → 当日桶
    insertLog('download', dFrom + DAY); // 次日 00:00:00.000 → 次日桶
    const dayRes = await getTrends(`metric=downloads&granularity=day&from=${dFrom}&to=${dFrom + 2 * DAY}`);
    expect(dayRes.body.data?.buckets).toEqual([
      { t: dFrom, count: 1 },
      { t: dFrom + DAY, count: 1 },
    ]);

    // week：2026-04-06 是周一；周日 04-12 归 04-06 那一周，次周一 04-13 单独成桶。
    // 注意区间隔离：把 04-12 23:59 换到 04-07（同一周但避开其它用例在 04-10 附近插入的数据），
    // 并用 04-13 00:00 验证次日周一归新桶。
    const monday = Date.UTC(2026, 3, 6);
    expect(new Date(monday).getUTCDay()).toBe(1);
    expect(new Date(Date.UTC(2026, 3, 12)).getUTCDay()).toBe(0);
    insertLog('download', Date.UTC(2026, 3, 7, 23, 59)); // 周二 → 04-06 桶
    insertLog('download', Date.UTC(2026, 3, 13, 0, 0)); // 次周一 → 04-13 桶
    const weekRes = await getTrends(`metric=downloads&granularity=week&from=${monday}&to=${Date.UTC(2026, 3, 20)}`);
    expect(weekRes.body.data?.buckets).toEqual([
      { t: monday, count: 1 },
      { t: Date.UTC(2026, 3, 13), count: 1 },
    ]);

    // month：边界落在当月 1 日
    const mFrom = Date.UTC(2026, 6, 20);
    insertLog('download', Date.UTC(2026, 6, 31, 23, 59)); // 7 月
    insertLog('download', Date.UTC(2026, 7, 1, 0, 0)); // 8 月
    const monthRes = await getTrends(`metric=downloads&granularity=month&from=${mFrom}&to=${Date.UTC(2026, 8, 1)}`);
    expect(monthRes.body.data?.buckets).toEqual([
      { t: Date.UTC(2026, 6, 1), count: 1 },
      { t: Date.UTC(2026, 7, 1), count: 1 },
    ]);
  });

  it('区间 [from, to)：from 含、to 不含；同桶内早于 from 的数据不计', async () => {
    const from = Date.UTC(2026, 5, 10, 12, 30); // 非对齐 → 首桶 12:00
    const to = from + 2 * HOUR; // 14:30 → 桶 12:00 / 13:00 / 14:00
    insertLog('download', Date.UTC(2026, 5, 10, 12, 29, 59, 999)); // 早于 from → 不计
    insertLog('download', Date.UTC(2026, 5, 10, 12, 30)); // 恰为 from → 计
    insertLog('download', Date.UTC(2026, 5, 10, 14, 29, 59, 999)); // to 前 1ms → 计
    insertLog('download', Date.UTC(2026, 5, 10, 14, 30)); // 恰为 to → 不计

    const { body } = await getTrends(`metric=downloads&granularity=hour&from=${from}&to=${to}`);
    expect(body.data?.buckets).toEqual([
      { t: Date.UTC(2026, 5, 10, 12), count: 1 },
      { t: Date.UTC(2026, 5, 10, 13), count: 0 },
      { t: Date.UTC(2026, 5, 10, 14), count: 1 },
    ]);

    // to 恰为桶起点时不产生尾部空桶
    const alignedFrom = Date.UTC(2026, 5, 20);
    insertLog('download', alignedFrom + HOUR);
    const aligned = await getTrends(
      `metric=downloads&granularity=day&from=${alignedFrom}&to=${alignedFrom + DAY}`
    );
    expect(aligned.body.data?.buckets).toEqual([{ t: alignedFrom, count: 1 }]);
  });

  it('缺省窗口：省略 from/to 返回最近 30 天（天桶对齐）', async () => {
    const { status, body } = await getTrends('metric=downloads&granularity=day');
    expect(status).toBe(200);
    const buckets = body.data?.buckets ?? [];
    expect(buckets.length === 30 || buckets.length === 31).toBe(true);
    for (const b of buckets) expect(b.t % DAY).toBe(0);
    expect(buckets[buckets.length - 1].t).toBeLessThanOrEqual(Date.now());
  });

  it('参数非法 / 区间过大 / 桶数过多 → 400', async () => {
    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2026, 0, 2);
    const cases = [
      `metric=nope&granularity=day&from=${from}&to=${to}`,
      `metric=downloads&granularity=fortnight&from=${from}&to=${to}`,
      `metric=downloads&granularity=day&from=abc&to=${to}`,
      `metric=downloads&granularity=day&from=${to}&to=${from}`, // from > to
      `metric=downloads&granularity=day&from=${to}&to=${to}`, // from == to
      'granularity=day', // 缺 metric
      `from=${from}&to=${to}`, // 缺 granularity
    ];
    for (const query of cases) {
      const { status, body } = await getTrends(query);
      expect(status, query).toBe(400);
      expect(body.error?.code, query).toBe('VALIDATION_ERROR');
    }

    // 区间长度上限 2 年（月粒度桶数远不到上限，只能被区间闸拦下）
    const tooLong = await getTrends(
      `metric=downloads&granularity=month&from=${Date.UTC(2020, 0, 1)}&to=${Date.UTC(2026, 0, 1)}`
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error?.message).toContain('2 年');

    // 桶数上限 400：hour 30 天 = 720 桶
    const tooMany = await getTrends(
      `metric=downloads&granularity=hour&from=${Date.UTC(2026, 0, 1)}&to=${Date.UTC(2026, 0, 31)}`
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error?.message).toContain('400');

    // 边界：day 400 桶放行，401 桶拒绝
    const ok400 = await getTrends(
      `metric=downloads&granularity=day&from=${Date.UTC(2026, 0, 1)}&to=${Date.UTC(2026, 0, 1) + 400 * DAY}`
    );
    expect(ok400.status).toBe(200);
    expect(ok400.body.data?.buckets.length).toBe(400);
    const over400 = await getTrends(
      `metric=downloads&granularity=day&from=${Date.UTC(2026, 0, 1)}&to=${Date.UTC(2026, 0, 1) + 401 * DAY}`
    );
    expect(over400.status).toBe(400);
  });

  it('鉴权：匿名 401、非管理员 403', async () => {
    const anon = await request(ctx, '/api/admin/dashboard/trends?metric=downloads&granularity=day');
    expect(anon.status).toBe(401);

    const { authCookie } = await registerAndLogin(ctx, 'trend_plain');
    const nonAdmin = await getTrends('metric=downloads&granularity=day', authCookie);
    expect(nonAdmin.status).toBe(403);
    expect(nonAdmin.body.error?.code).toBe('FORBIDDEN');
  });
});

describe('趋势埋点', () => {
  it('登录成功落 action=login，失败只落 login_failed', async () => {
    const { userId } = await registerAndLogin(ctx, 'trend_login_user');
    expect(countLogs(`user_id = ? AND action = 'login'`, userId)).toBe(1);

    const bad = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'trend_login_user', password: 'wrong-password' },
    });
    expect(bad.status).toBe(401);
    expect(countLogs(`user_id = ? AND action = 'login'`, userId)).toBe(1);
    expect(countLogs(`user_id = ? AND action = 'login_failed'`, userId)).toBe(1);

    const good = await request(ctx, '/api/auth/login', {
      method: 'POST',
      body: { username: 'trend_login_user', password: 'password123' },
    });
    expect(good.status).toBe(200);
    expect(countLogs(`user_id = ? AND action = 'login'`, userId)).toBe(2);

    // 端点能读到这两次登录（最近一小时的桶合计 >= 2）
    const from = Date.now() - HOUR;
    const to = Date.now() + HOUR;
    const { status, body } = await getTrends(`metric=logins&granularity=hour&from=${from}&to=${to}`);
    expect(status).toBe(200);
    expect((body.data?.buckets ?? []).reduce((s, b) => s + b.count, 0)).toBeGreaterThanOrEqual(2);
  });

  it('下载埋点：网关出口落 action=download，签发链接落 download_link', async () => {
    const { authCookie } = await registerAndLogin(ctx, 'trend_dl_user');
    const uploaded = await uploadFile(authCookie, 'trend-download.txt', 'trend-download-content');
    const downloadsBefore = countLogs(`action = 'download'`);

    // 签发下载链接（预览也走本端点）：只记 download_link
    const linkRes = await request(ctx, `/api/files/${uploaded.id}/download`, { cookie: authCookie });
    expect(linkRes.status).toBe(200);
    const linkBody = await json<{ data: { url: string } }>(linkRes);
    const url = linkBody.data.url.replace('http://localhost:8787', '');
    expect(countLogs(`action = 'download'`)).toBe(downloadsBefore);
    expect(countLogs(`action = 'download_link' AND metadata LIKE ?`, '%trend-download.txt%')).toBe(1);

    // 实际下载：网关消费令牌成功后记 action=download
    const dl = await request(ctx, url);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('trend-download-content');
    expect(countLogs(`action = 'download'`)).toBe(downloadsBefore + 1);
    // node:sqlite 行是 unknown；固定取最新一条 download 行的 metadata
    const row = ctx.db
      .prepare(`SELECT metadata FROM access_logs WHERE action = 'download' ORDER BY created_at DESC LIMIT 1`)
      .get() as { metadata: string };
    expect(JSON.parse(row.metadata).fileName).toBe('trend-download.txt');

    // 趋势端点按小时桶读到这次下载
    const { status, body } = await getTrends(
      `metric=downloads&granularity=hour&from=${Date.now() - HOUR}&to=${Date.now() + HOUR}`
    );
    expect(status).toBe(200);
    expect((body.data?.buckets ?? []).reduce((s, b) => s + b.count, 0)).toBeGreaterThanOrEqual(1);
  });
});
