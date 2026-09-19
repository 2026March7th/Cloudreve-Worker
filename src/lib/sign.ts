/**
 * URL / 请求签名。对应 Cloudreve v4 的 `pkg/auth/hmac.go`。
 *
 * 签名值格式：`base64url(HMAC-SHA256(body + ":" + expires)) + ":" + expires`
 *   - `body` 对 URL 签名而言就是**路径**（不含 query，见 `getUrlSignContent`）；
 *   - base64url **带 `=` 填充**，与上游 Go 的 `base64.URLEncoding` 一致；
 *   - `expires` 为 0 表示永不过期；
 *   - 校验时从签名串尾部解析有效期，先判过期再比对摘要。
 *
 * 签名以 `?sign=` 查询参数附加到 URL 上（原版 `SignURI`）。
 */
import { base64UrlToString, bytesToBase64UrlPadded } from './crypto';
import { AppError, CodeInvalidSign, CodeSignExpired } from './errors';

export class Signer {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string) {}

  private key(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      this.keyPromise = crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
    }
    return this.keyPromise;
  }

  async sign(body: string, expires = 0): Promise<string> {
    const payload = `${body}:${expires}`;
    const mac = await crypto.subtle.sign('HMAC', await this.key(), new TextEncoder().encode(payload));
    // 带填充，与上游 Go 的 base64.URLEncoding 对齐（不是 JWT 的无填充写法）
    return `${bytesToBase64UrlPadded(new Uint8Array(mac))}:${expires}`;
  }

  async check(body: string, sign: string): Promise<void> {
    const parts = sign.split(':');
    const expiresRaw = parts[parts.length - 1];
    if (expiresRaw === '') {
      throw new AppError(403, 'expire timestamp is missing');
    }
    const expires = Number.parseInt(expiresRaw ?? '', 10);
    if (!Number.isFinite(expires)) {
      throw new AppError(CodeInvalidSign, 'sign expired');
    }
    if (expires !== 0 && expires < Math.floor(Date.now() / 1000)) {
      throw new AppError(CodeSignExpired, 'signature expired');
    }
    const expected = await this.sign(body, expires);
    if (expected !== sign) {
      throw new AppError(CodeInvalidSign, 'invalid sign');
    }
  }

  /** 给 URL 附加 `sign` 查询参数。 */
  async signUrl(url: string, expires = 0): Promise<string> {
    const parsed = new URL(url);
    const sign = await this.sign(pathOf(parsed), expires);
    parsed.searchParams.set('sign', sign);
    return parsed.toString();
  }

  /** 校验带 `sign` 查询参数的 URL。 */
  async checkUrl(url: string): Promise<void> {
    const parsed = new URL(url);
    const sign = parsed.searchParams.get('sign');
    if (!sign) throw new AppError(403, 'authorization header is missing');
    parsed.searchParams.delete('sign');
    await this.check(pathOf(parsed), sign);
  }
}

/** 参与签名的正文：路径，空则视作 `/`（与原版 getUrlSignContent 一致）。 */
function pathOf(url: URL): string {
  return url.pathname === '' ? '/' : url.pathname;
}

/**
 * 校验来自请求的签名（header 或 query）。
 * 原版支持两种携带方式：`Authorization: Bearer Cr <sign>` 与 `?sign=`。
 */
export async function verifyRequestSign(
  signer: Signer,
  args: { path: string; authorization?: string | null; querySign?: string | null },
): Promise<void> {
  const fromHeader = args.authorization?.startsWith('Bearer Cr ')
    ? args.authorization.slice('Bearer Cr '.length)
    : null;
  const sign = fromHeader ?? args.querySign ?? null;
  if (!sign) {
    throw new AppError(403, 'authorization header is missing');
  }
  await signer.check(args.path, sign);
}

export { base64UrlToString };
