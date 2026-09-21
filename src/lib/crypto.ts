/**
 * 密码摘要、随机串与摘要工具。
 *
 * 密码存储格式对应 Cloudreve v4 `inventory/user.go` 的 `digestPassword`：
 *   `<32位随机salt>:<sha256hex(password + salt)>`
 * 校验时按冒号切分；第二段长度为 64 视为 sha256（v4），否则按 sha1 处理（v3 兼容）。
 */

import { md5 } from './md5';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 生成指定长度的随机串，取自密码学安全随机源。 */
export function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

export async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

/** SHA-256 原始字节，用于 refresh token 的 state_hash。 */
export async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return new Uint8Array(digest);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 恒定时间比较，避免签名比对被计时攻击。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 生成密码摘要：`<salt>:<sha256hex(password+salt)>`。 */
export async function digestPassword(password: string): Promise<string> {
  const salt = randomString(32);
  const digest = await sha256Hex(password + salt);
  return `${salt}:${digest}`;
}

/**
 * 校验明文密码是否与存储的摘要匹配。
 *
 * 与上游保持逐字一致的判定顺序：
 *   1. 按 `:` 切分，段数必须是 2 或 3，否则视为未知格式；
 *   2. 3 段（v2 遗留的 `md5:<hash>:<salt>`）需要 MD5 —— Web Crypto 不提供 MD5，
 *      这里如实返回「未知密码类型」。该分支只影响从 v2 老库迁移过来的账号，
 *      全新部署不会产生这种格式。见 README「已知差异」。
 *   3. 第二段长度为 64 用 SHA-256，否则用 SHA-1（v3 兼容），
 *      比对 `H(password + salt)`，其中 salt 是第一段。
 */
export interface PasswordCheckResult {
  ok: boolean;
  /** 命中 v2 老格式且校验通过时，附带重算后的 v4 摘要，供调用方惰性升级为安全格式。 */
  upgradeToV4?: string;
}

export async function checkPassword(
  stored: string | null | undefined,
  password: string,
): Promise<PasswordCheckResult> {
  if (!stored) return { ok: false };
  const parts = stored.split(':');
  if (parts.length !== 2 && parts.length !== 3) return { ok: false };

  // v2 遗留格式：`md5:<hash>:<salt>`。Cloudreve v2 的 digestPassword 为
  // `md5(password + salt)`（个别版本写成 `md5(md5(password) + salt)`，两种都试）。
  // Web Crypto 不提供 MD5，这里用自实现的 md5.ts（与 Epay 协议同款）。
  if (parts.length === 3 && parts[0] === 'md5') {
    const expected = parts[1];
    const salt = parts[2];
    const candidates = [md5(password + salt), md5(md5(password) + salt)];
    if (candidates.some((c) => timingSafeEqual(c, expected))) {
      return { ok: true, upgradeToV4: await digestPassword(password) };
    }
    return { ok: false };
  }

  if (parts.length === 3) {
    // 其它 3 段格式暂不支持
    return { ok: false };
  }

  const [salt, expected] = parts as [string, string];
  const hasher = expected.length === 64 ? sha256Hex : sha1Hex;
  const actual = await hasher(password + salt);
  return { ok: timingSafeEqual(actual, expected) };
}

/** 生成 RFC4122 v4 UUID。 */
export function uuidv4(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// base64 / base64url
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** base64url **无填充**（JWT 用的是这种，RFC 7515 要求去掉 `=`）。 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url **带填充**。
 *
 * 只给 URL 签名用（`lib/sign.ts`）：上游用的是 Go 的 `base64.URLEncoding`，
 * 它**保留** `=` 填充；而 JWT 用的 `base64.RawURLEncoding`（见 `pkg/auth/jwt.go`）
 * 才去掉填充。两者不能混用 —— 32 字节的 HMAC-SHA256 摘要带填充是 44 字符
 * （43 + `=`），不带是 43 字符，签名串因此对不上，跨端校验必然失败
 * （例如从原版 Go 后端生成的直链由本 Worker 校验时）。
 */
export function bytesToBase64UrlPadded(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_');
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return base64ToBytes(padded + pad);
}

export function stringToBase64Url(s: string): string {
  return bytesToBase64Url(encoder.encode(s));
}

export function base64UrlToString(s: string): string {
  return new TextDecoder().decode(base64UrlToBytes(s));
}

/** Hex 字符串转 bytea 字面量（供 Postgres 参数使用），空串表示为 `\x`。 */
export function hexToByteaLiteral(hex: string): string {
  return `\\x${hex}`;
}
