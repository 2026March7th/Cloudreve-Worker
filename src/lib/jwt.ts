/**
 * JWT 签发与校验。对应 Cloudreve v4 的 `pkg/auth/jwt.go`。
 *
 * 实现要点（逐条对齐原版）：
 *   - 算法固定 HS256，密钥为站点级 secret；
 *   - `sub` 是 hashid 编码的用户 ID；
 *   - access token 携带 `token_type=access` + `scopes` + `client_id`；
 *   - refresh token 额外携带 `state_hash`（sha256(email/password/siteId) 的
 *     base64）与 `root_token_id`（UUID）——密码变更或会话被吊销时失效；
 *   - 只写 `sub` / `nbf` / `exp` 三个注册声明，与原版一致（不写 iat）。
 */
import {
  base64UrlToBytes,
  bytesToBase64Url,
  stringToBase64Url,
  base64UrlToString,
  sha256Bytes,
} from './crypto';

export type TokenType = 'access' | 'refresh';

export const TokenTypeAccess: TokenType = 'access';
export const TokenTypeRefresh: TokenType = 'refresh';

export const AuthorizationHeader = 'Authorization';
export const TokenHeaderPrefix = 'Bearer ';
export const TokenHeaderPrefixCr = 'Bearer Cr ';
export const RevokeTokenPrefix = 'jwt_revoke_';

export interface Claims {
  token_type: TokenType;
  sub: string;
  nbf?: number;
  exp?: number;
  /** 仅 refresh token：base64 的 sha256 摘要 */
  state_hash?: string;
  /** 仅 refresh token */
  root_token_id?: string;
  scopes?: string[];
  client_id?: string;
}

export interface Token {
  access_token: string;
  refresh_token: string;
  /** RFC3339 时间字符串 */
  access_expires: string;
  refresh_expires: string;
}

/** 将 Uint8Array 编码成 base64 —— 模拟 Go 对 `[]byte` 的 JSON 编码（标准 base64）。 */
function bytesToStandardBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function standardBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class JWTService {
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

  private async sign(payload: Claims): Promise<string> {
    const header = stringToBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = stringToBase64Url(JSON.stringify(payload));
    const data = `${header}.${body}`;
    const sig = await crypto.subtle.sign('HMAC', await this.key(), new TextEncoder().encode(data));
    return `${data}.${bytesToBase64Url(new Uint8Array(sig))}`;
  }

  /** 解析并校验签名与 exp/nbf。失败返回 null（与原版「解析失败即忽略」一致）。 */
  async verify(tokenStr: string): Promise<Claims | null> {
    const parts = tokenStr.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts as [string, string, string];

    let valid: boolean;
    try {
      valid = await crypto.subtle.verify(
        'HMAC',
        await this.key(),
        base64UrlToBytes(sig),
        new TextEncoder().encode(`${header}.${body}`),
      );
    } catch {
      return null;
    }
    if (!valid) return null;

    let claims: Claims;
    try {
      claims = JSON.parse(base64UrlToString(body)) as Claims;
    } catch {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && claims.exp < now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
    return claims;
  }

  /**
   * 签发一对 token。
   * @param subject hashid 编码的用户 ID
   * @param stateHash sha256(email/password/siteId) 原始字节
   * @param accessTTLSeconds access token 有效期（秒）
   * @param refreshTTLSeconds refresh token 有效期（秒）
   */
  async issue(args: {
    subject: string;
    stateHash: Uint8Array;
    accessTTLSeconds: number;
    refreshTTLSeconds: number;
    rootTokenId?: string;
    scopes?: string[];
    clientId?: string;
  }): Promise<Token> {
    const now = Math.floor(Date.now() / 1000);
    const accessExp = now + args.accessTTLSeconds;
    const refreshExp = now + args.refreshTTLSeconds;
    const rootTokenId = args.rootTokenId ?? crypto.randomUUID();

    const accessToken = await this.sign({
      token_type: TokenTypeAccess,
      sub: args.subject,
      nbf: now,
      exp: accessExp,
      ...(args.clientId ? { client_id: args.clientId } : {}),
      ...(args.scopes?.length ? { scopes: args.scopes } : {}),
    });

    const refreshToken = await this.sign({
      token_type: TokenTypeRefresh,
      sub: args.subject,
      nbf: now,
      exp: refreshExp,
      state_hash: bytesToStandardBase64(args.stateHash),
      root_token_id: rootTokenId,
      ...(args.clientId ? { client_id: args.clientId } : {}),
      ...(args.scopes?.length ? { scopes: args.scopes } : {}),
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      access_expires: new Date(accessExp * 1000).toISOString(),
      refresh_expires: new Date(refreshExp * 1000).toISOString(),
    };
  }
}

/** 计算用户的 state hash：sha256(`email/password/siteId`)。 */
export function hashUserState(email: string, password: string, siteId: string): Promise<Uint8Array> {
  return sha256Bytes(`${email}/${password}/${siteId}`);
}

/** 校验请求声明的 scope 是否为客户端允许 scope 的子集。 */
export function validateScopes(requested: string[], allowed: string[]): boolean {
  const set = new Set(allowed);
  return requested.every((s) => set.has(s));
}

/**
 * 判断 token 是否覆盖所需 scope。写权限隐式包含对应读权限
 * （`Files.Write` ⇒ 同时具备 `Files.Read`），与原版一致。
 */
export function checkScope(tokenScopes: string[] | undefined, required: string[]): boolean {
  if (!tokenScopes) return true; // 内置登录（非 OAuth 客户端）不受 scope 限制
  const set = new Set<string>();
  for (const s of tokenScopes) {
    set.add(s);
    if (s.endsWith('.Write') && s.length > '.Write'.length) {
      set.add(`${s.slice(0, -'.Write'.length)}.Read`);
    }
  }
  return required.every((r) => set.has(r));
}

/** state_hash 比对。 */
export function stateHashEquals(claims: Claims, expected: Uint8Array): boolean {
  if (!claims.state_hash) return false;
  let actual: Uint8Array;
  try {
    actual = standardBase64ToBytes(claims.state_hash);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}
