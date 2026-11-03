// 请求信任、路径规范、敏感路径策略。
//
// 契约见 docs/0.3.0-fix-contract.md §1/§2。
//
// 诚实声明（红队裁决后写入注释，README 同步）：这里的"信任判定"挡得住跨站页面与
// DNS rebinding，**挡不住本机任意进程**——它没有密钥、cookie 或会话绑定。它不是身份
// 认证，只是同源/回环的启发式校验。

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const TRUST_HEADER = 'x-dsh-workspace-studio';

export interface RequestSecurityLike {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

function headerOf(req: RequestSecurityLike, name: string): string | undefined {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** 只认回环 **IP 字面量**；主机名一律不认（`127.evil.com` 这类前缀骗术必须挡住）。 */
function isLoopbackLiteral(value: string | undefined): boolean {
  if (!value) return false;
  const addr = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
  if (octets.some((o) => !Number.isFinite(o) || o < 0 || o > 255)) return false;
  return octets[0] === 127;
}

/** Host/Origin 里的主机：允许回环 IP 字面量，或**正好是** localhost / localhost.。 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === 'localhost.') return true;
  return isLoopbackLiteral(h);
}

/**
 * 读/写接口的信任判定（契约 §2）：
 * - `x-dsh-workspace-studio: 1`
 * - 对端必须是回环 IP 字面量
 * - 有 `sec-fetch-site` 时必须 same-origin
 * - 有 `origin` 时必须与 host 同源且主机为回环
 */
export function isTrustedRequest(req: RequestSecurityLike): boolean {
  if (headerOf(req, TRUST_HEADER) !== '1') return false;
  if (!isLoopbackLiteral(req.socket?.remoteAddress)) return false;

  const site = headerOf(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') return false;

  const host = headerOf(req, 'host');
  if (host === undefined || host === '') return false;

  const origin = headerOf(req, 'origin');
  if (origin === undefined || origin === '') {
    // 无 Origin（非浏览器客户端）：只要求 Host 指向回环
    try {
      return isLoopbackHostname(new URL(`http://${host}`).hostname);
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.host === host && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 统一路径口径（契约 §1）：绝对路径 → 归一化、统一 `/`、Windows 折叠大小写、去尾分隔符。
 * 台账比较、授权、去重、分桶都必须用它。非绝对路径返回 undefined。
 */
export function canonicalPath(target: string): string | undefined {
  if (typeof target !== 'string') return undefined;
  const trimmed = target.trim();
  if (trimmed === '') return undefined;
  const isWin =
    process.platform === 'win32' ||
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\');
  const impl = isWin ? win32 : posix;
  if (!impl.isAbsolute(trimmed)) return undefined;
  const normalized = impl.normalize(trimmed).replace(/[\\/]+$/, '');
  return isWin ? normalized.replace(/\\/g, '/').toLowerCase() : normalized;
}

/** target 是否等于某个根、或位于其下（按 canonical 口径比较）。 */
export function isPathInsideWorkspace(target: string, roots: readonly string[]): boolean {
  const t = canonicalPath(target);
  if (t === undefined) return false;
  for (const root of roots) {
    const r = canonicalPath(root);
    if (r === undefined || r === '') continue;
    if (t === r) return true;
    if (t.startsWith(`${r}/`)) return true;
  }
  return false;
}

/** 敏感文件名/目录（契约 §2）：读写都拒绝，避免把工作区内的凭据当普通文件服务。 */
const SENSITIVE_SEGMENT_TEST = [
  /^\.secrets$/i,
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.key$/i,
  /\.pem$/i,
  /^id_rsa.*$/i,
  /^id_ed25519.*$/i,
  /^id_ecdsa.*$/i,
  /^credentials.*$/i,
  /^\.netrc$/i,
];

export function isSensitivePath(target: string): boolean {
  const canonical = canonicalPath(target);
  if (canonical === undefined) return false;
  const home = canonicalPath(homedir());
  if (home !== undefined && (canonical === `${home}/.dsh` || canonical.startsWith(`${home}/.dsh/`))) {
    return true;
  }
  for (const segment of canonical.split('/')) {
    if (segment === '') continue;
    if (SENSITIVE_SEGMENT_TEST.some((re) => re.test(segment))) return true;
  }
  return false;
}
