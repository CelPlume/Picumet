// SSRF 防护：禁止配置内网/本机/保留/回环/链路本地/文档地址，覆盖 IPv4 与 IPv6；
// 管理端 Provider 创建与自由模式初始化统一走 validateEndpoint。
// 说明：Workers 无法在请求内解析 DNS，最终地址校验依赖平台网络出口限制；此处尽力覆盖
// 可静态判断的私网/保留段、IPv4-mapped/NAT64/6to4 内嵌 IPv4、scheme/端口/userinfo。

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** IPv4 私网/保留/回环/链路本地/文档/多播/保留段全量判断（基于八位组，直观不易错） */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10（CGNAT）
  if (a === 127) return true; // 127.0.0.0/8（回环）
  if (a === 169 && b === 254) return true; // 169.254.0.0/16（链路本地）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24（TEST-NET-1）
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && b === 18 && c <= 1) return true; // 198.18.0.0/15（基准测试）
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24（TEST-NET-2）
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24（TEST-NET-3）
  if (a >= 224) return true; // 224.0.0.0/4 多播 + 240.0.0.0/4 保留 + 255.255.255.255
  return false;
}

/** IPv6 私网/保留/回环/链路本地/ULA/文档/多播 + IPv4 内嵌形式判断 */
function isPrivateIpv6(addr: string): boolean {
  const a = addr.toLowerCase().replace(/\[|\]/g, '').split('%')[0]; // 去掉 zone index
  if (a === '::' || a === '::1') return true; // 未指定 / 回环
  if (a.startsWith('fe80') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // 链路本地 fe80::/10
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // ULA fc00::/7
  if (a.startsWith('2001:db8')) return true; // 文档 2001:db8::/32
  if (a.startsWith('ff')) return true; // 多播 ff00::/8
  // ::ffff:0:0/96（IPv4-mapped）
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  // 64:ff9b::/96 与 64:ff9b:1::/48（NAT64 内嵌 IPv4）
  // 注意：字面 '64:ff9b:' 已消费 ff9b 后第一个冒号，剩余为 ':ip'（:: 形式）或 '1::ip'（/48 形式）
  const nat64 = a.match(/^64:ff9b:(?:1::|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (nat64) return isPrivateIpv4(nat64[1]);
  // 2002::/16（6to4 内嵌 IPv4：2002:XXXX:YYYY::）
  const sixToFour = a.match(/^2002:([0-9a-f]{4}):([0-9a-f]{4})(?:$|:)/);
  if (sixToFour) {
    const p1 = parseInt(sixToFour[1], 16);
    const p2 = parseInt(sixToFour[2], 16);
    return isPrivateIpv4(`${(p1 >> 8) & 255}.${p1 & 255}.${(p2 >> 8) & 255}.${p2 & 255}`);
  }
  return false;
}

const BLOCKED_HOSTNAMES = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
];

/** hostname 是否为私网/保留/内部地址（支持 IPv4、IPv6、主机名黑名单） */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.includes(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) return isPrivateIpv6(host);
  if (/^[\d.]+$/.test(host)) return isPrivateIpv4(host);
  return false;
}

/**
 * 端点校验：scheme http/https、无内嵌凭据、端口白名单（80/443）、非私网/保留地址。
 */
export function validateEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    // 禁止 URL 内嵌凭据（userinfo 是 SSRF/凭据泄漏向量）
    if (url.username || url.password) return false;
    // 端口白名单：仅允许默认 80/443，或未显式指定的标准端口
    if (url.port) {
      const p = Number(url.port);
      if (p !== 80 && p !== 443) return false;
    }
    return !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}
