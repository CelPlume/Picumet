// SSRF 防护：禁止管理端配置内网/本机地址
import type { Env } from '../types';

function ipToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip: string): boolean {
  const int = ipToInt(ip);
  if (int === null) return false;
  if (int >>> 24 === 10) return true; // 10.0.0.0/8
  if ((int >>> 16) === 0xac1) return true; // 172.16.0.0/12
  if ((int >>> 16) === 0xc0a8) return true; // 192.168.0.0/16
  if ((int >>> 24) === 127) return true; // 127.0.0.0/8
  if ((int >>> 16) === 0xa9fe) return true; // 169.254.0.0/16
  if (int === 0) return true; // 0.0.0.0
  return false;
}

const BLOCKED_HOSTNAMES = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '::1',
  'metadata.google.internal',
  'metadata',
];

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.includes(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^[\d.]+$/.test(host)) return isPrivateIp(host);
  return false;
}

export function validateEndpoint(endpoint: string, env?: Env): boolean {
  void env;
  try {
    const url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    return !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}
