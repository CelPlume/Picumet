// 客户端真实 IP 解析：全站统一出口，收敛各处自行实现的 XFF 首段解析。
// 优先级：
//   1. `cf.connectingIp` —— Cloudflare Workers 运行时注入的属性，客户端请求不可伪造；
//   2. `CF-Connecting-IP` 头 —— Cloudflare 官方建议的应用层来源（边缘会覆盖客户端同名头）；
//   3. `X-Real-IP` / `X-Forwarded-For` 首段 —— 仅在非 Cloudflare 部署（本地 wrangler dev、
//      Vite 代理）下作为受控回退；生产部署在 Cloudflare 之后时永远命中 1/2。
// XFF 首段在无可信代理时可被客户端任意伪造：安全判定（API Key IP 白名单、自由模式 IP 绑定、
// 权限条件 IP）不得在 Cloudflare 之外的环境声称绝对可信，测试见 workers/tests/api-key-ip.test.ts。

interface CfRequest extends Request {
  cf?: { connectingIp?: string };
}

function firstForwarded(req: Request): string | undefined {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || undefined;
  return undefined;
}

/** 安全判定用：必返回一个 IP（无任何来源时回退 127.0.0.1，与既有行为一致） */
export function clientIp(req: Request): string {
  const cf = (req as CfRequest).cf;
  if (cf?.connectingIp) return cf.connectingIp;
  const cfc = req.headers.get('cf-connecting-ip')?.trim();
  if (cfc) return cfc;
  return firstForwarded(req) ?? '127.0.0.1';
}

/** 日志/埋点用：无来源时返回 undefined（不把回退值写进审计日志） */
export function requestIp(req: Request): string | undefined {
  const cf = (req as CfRequest).cf;
  if (cf?.connectingIp) return cf.connectingIp;
  const cfc = req.headers.get('cf-connecting-ip')?.trim();
  if (cfc) return cfc;
  return firstForwarded(req);
}
