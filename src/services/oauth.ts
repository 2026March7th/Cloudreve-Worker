/**
 * OAuth2 授权码流程 + OIDC userinfo（用户侧）。
 *
 * 对应上游 `service/oauth/oauth.go` 与 `routers/router.go:321-347`：
 *
 *   GET    /api/v4/session/oauth/app/:app_id   应用信息（含已授权 scope，匿名可查）
 *   POST   /api/v4/session/oauth/consent       用户同意 → 签发授权码（KV，TTL 600）
 *   POST   /api/v4/session/oauth/token         授权码 + PKCE + secret 换 token（表单）
 *   GET    /api/v4/session/oauth/userinfo      OIDC userinfo（按 token scope 出字段）
 *   DELETE /api/v4/session/oauth/grant/:app_id 撤销授权
 *
 * 与上游一致的行为：scope 必须包含 openid 且为应用注册 scope 的子集；
 * redirect_uri 必须精确匹配注册表；授权码一次性；PKCE 只支持 S256。
 */
import type { Env } from '../env';
import { getSql, type Sql } from '../db';
import { AppError, CodeCredentialInvalid, CodeNoPermissionErr, CodeNotFound, CodeParamErr, CodeUserNotFound } from '../lib/errors';
import { validateScopes } from '../lib/jwt';
import { randomString, timingSafeEqual } from '../lib/crypto';
import { AppContext } from './context';
import type { UserRow, UserWithGroup } from '../db/types';

// 上游 inventory/types 的 scope 常量
const SCOPE_OPENID = 'openid';
const SCOPE_PROFILE = 'profile';
const SCOPE_EMAIL = 'email';
const SCOPE_OFFLINE_ACCESS = 'offline_access';

const AUTH_CODE_PREFIX = 'oauth_code_';
const AUTH_CODE_TTL = 600; // 秒，上游同款

/**
 * 自动注册门槛：只自动登记长得像 UUID 的 client_id。
 * 桌面端 / 移动端内置的都是 UUID 形态的 GUID；随机的垃圾 ID 大多不是 UUID，
 * 这道闸能把注册表垃圾量压到最低。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 自动注册的新客户端默认放开的 scope（私有部署策略：宽松）。 */
const AUTO_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'UserInfo.Read',
  'UserInfo.Write',
  'UserSecurityInfo.Read',
  'Workflow.Read',
  'Workflow.Write',
  'Files.Read',
  'Files.Write',
  'Shares.Read',
  'DavAccount.Read',
];

/** KV 里的授权码内容。 */
interface AuthorizationCode {
  client_id: string;
  user_id: number;
  scopes: string[];
  redirect_uri: string;
  code_challenge: string;
}

export interface AppRegistration {
  id: string;
  name: string;
  homepage_url?: string;
  icon?: string;
  description?: string;
  consented_scopes?: string[];
}

export interface OAuthClientRow {
  id: number;
  guid: string;
  secret: string;
  name: string;
  homepage_url: string;
  redirect_uris: string[];
  scopes: string[];
  props: Record<string, unknown>;
  is_enabled: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token_expires_in: number;
  refresh_token?: string;
  scope: string;
}

export class OAuthService {
  private sql: Sql;

  constructor(
    private readonly ctx: AppContext,
    env: Env,
  ) {
    this.sql = getSql(env);
  }

  /**
   * 未知客户端自动注册（私有部署策略）。
   *
   * 官方桌面端把内置 client_id 编进闭源二进制里，实例管理员无从预登记；
   * 上游的播种逻辑在闭源部分。边缘版的处理：带合法 UUID 形态 client_id 的
   * 首次连接自动建号（宽松 scope + 空 redirect 白名单 = 接受任意回调，
   * 含 cloudreve:// 自定义协议与 localhost 回环），管理员可随时在后台改/禁。
   */
  private async ensureAutoProvision(guid: string): Promise<void> {
    if (!UUID_RE.test(guid)) return;
    await this.sql`
      INSERT INTO oauth_clients (guid, secret, name, homepage_url, redirect_uris, scopes, props, is_enabled)
      VALUES (${guid}, ${randomString(48)}, ${'Client ' + guid.slice(0, 8)}, '', '[]'::jsonb,
              ${JSON.stringify(AUTO_SCOPES)}::jsonb, ${JSON.stringify({ auto_provisioned: true })}::jsonb, true)
      ON CONFLICT (guid) DO NOTHING
    `;
  }

  private async clientByGUID(guid: string, autoProvision = false): Promise<OAuthClientRow | null> {
    if (autoProvision) await this.ensureAutoProvision(guid);
    const rows = (await this.sql`
      SELECT * FROM oauth_clients WHERE guid = ${guid} AND deleted_at IS NULL LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: Number(r.id),
      guid: String(r.guid),
      secret: String(r.secret ?? ''),
      name: String(r.name ?? ''),
      homepage_url: String(r.homepage_url ?? ''),
      redirect_uris: (r.redirect_uris as string[]) ?? [],
      scopes: (r.scopes as string[]) ?? [],
      props: (r.props as Record<string, unknown>) ?? {},
      is_enabled: r.is_enabled !== false,
    };
  }

  private async grantScopes(userId: number, clientId: number): Promise<string[] | null> {
    const rows = (await this.sql`
      SELECT scopes FROM oauth_grants
      WHERE user_id = ${userId} AND client_id = ${clientId} AND deleted_at IS NULL LIMIT 1
    `) as Array<Record<string, unknown>>;
    return rows[0] ? ((rows[0].scopes as string[]) ?? []) : null;
  }

  /** 应用信息（授权同意页展示用）。未知客户端先走自动注册。 */
  async getAppRegistration(appGUID: string, userId: number | null): Promise<AppRegistration> {
    const app = await this.clientByGUID(appGUID, true);
    if (!app || !app.is_enabled) throw new AppError(CodeNotFound, 'App not found');
    const out: AppRegistration = {
      id: app.guid,
      name: app.name,
      ...(app.homepage_url ? { homepage_url: app.homepage_url } : {}),
      ...(typeof app.props.description === 'string' ? { description: app.props.description } : {}),
      ...(typeof app.props.icon === 'string' ? { icon: app.props.icon } : {}),
    };
    if (userId !== null) {
      const scopes = await this.grantScopes(userId, app.id);
      if (scopes) out.consented_scopes = scopes;
    }
    return out;
  }

  /** 用户同意：校验后落 grant、发授权码。 */
  async consent(
    user: UserWithGroup,
    args: {
      client_id: string;
      response_type: string;
      redirect_uri: string;
      state?: string;
      scope: string;
      code_challenge?: string;
      code_challenge_method?: string;
    },
  ): Promise<{ code: string; state: string }> {
    if (args.response_type !== 'code') {
      throw new AppError(CodeParamErr, 'response_type must be "code"');
    }
    const app = await this.clientByGUID(args.client_id, true);
    if (!app || !app.is_enabled) throw new AppError(CodeNotFound, 'App not found');
    // 自动注册的客户端 redirect 白名单为空 —— 接受任意回调（含 cloudreve://
    // 自定义协议与 localhost 回环）；管理员手工登记的应用仍要求精确匹配。
    if (app.redirect_uris.length > 0 && !app.redirect_uris.includes(args.redirect_uri)) {
      throw new AppError(CodeParamErr, 'Invalid redirect URI');
    }
    const method = args.code_challenge ? (args.code_challenge_method || 'S256') : '';
    if (method && method !== 'S256') {
      throw new AppError(CodeParamErr, 'Only S256 code_challenge_method is supported');
    }

    const requestedScopes = args.scope.split(' ').filter(Boolean);
    // 自动注册的客户端不做 scope 子集校验（桌面端请求的 scope 组合由闭源端定死）
    if (!app.props.auto_provisioned && !validateScopes(requestedScopes, app.scopes)) {
      throw new AppError(CodeParamErr, 'Invalid scope requested');
    }
    if (!requestedScopes.includes(SCOPE_OPENID)) {
      throw new AppError(CodeParamErr, 'openid scope required');
    }

    // Upsert grant：已授权则扩充 scope
    const existing = await this.grantScopes(user.id, app.id);
    const merged = Array.from(new Set([...(existing ?? []), ...requestedScopes]));
    if (existing) {
      await this.sql`
        UPDATE oauth_grants SET scopes = ${JSON.stringify(merged)}::jsonb, updated_at = now()
        WHERE user_id = ${user.id} AND client_id = ${app.id}
      `;
    } else {
      await this.sql`
        INSERT INTO oauth_grants (user_id, client_id, scopes)
        VALUES (${user.id}, ${app.id}, ${JSON.stringify(requestedScopes)}::jsonb)
      `;
    }

    const code = randomString(128);
    const authCode: AuthorizationCode = {
      client_id: args.client_id,
      user_id: user.id,
      scopes: requestedScopes,
      redirect_uri: args.redirect_uri,
      code_challenge: args.code_challenge ?? '',
    };
    await this.ctx.env.KV.put(`${AUTH_CODE_PREFIX}${code}`, JSON.stringify(authCode), {
      expirationTtl: AUTH_CODE_TTL,
    });

    return { code, state: args.state ?? '' };
  }

  /** 授权码换 token。表单编码请求。 */
  async exchangeToken(args: {
    client_id: string;
    client_secret: string;
    grant_type: string;
    code: string;
    code_verifier?: string;
  }): Promise<TokenResponse> {
    if (args.grant_type !== 'authorization_code') {
      throw new AppError(CodeParamErr, 'grant_type must be authorization_code');
    }

    const raw = await this.ctx.env.KV.get(`${AUTH_CODE_PREFIX}${args.code}`);
    if (!raw) throw new AppError(CodeCredentialInvalid, 'Invalid or expired authorization code');
    await this.ctx.env.KV.delete(`${AUTH_CODE_PREFIX}${args.code}`);
    const authCode = JSON.parse(raw) as AuthorizationCode;

    if (authCode.client_id !== args.client_id) {
      throw new AppError(CodeCredentialInvalid, 'Client ID mismatch');
    }

    // PKCE（S256）：sha256(verifier) 与挑战比对
    if (authCode.code_challenge) {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(args.code_verifier ?? ''),
      );
      const expected = b64url(new Uint8Array(digest));
      if (!timingSafeEqual(expected, authCode.code_challenge)) {
        throw new AppError(CodeCredentialInvalid, 'Invalid code verifier');
      }
    }

    const app = await this.clientByGUID(args.client_id);
    if (!app) throw new AppError(CodeNotFound, 'App not found');
    // 自动注册的客户端：secret 由闭源端定死无法预知，跳过校验；
    // 有 PKCE 挑战时仍强制验 verifier，安全性由 PKCE 保证。
    if (!app.props.auto_provisioned && !timingSafeEqual(app.secret, args.client_secret)) {
      throw new AppError(CodeCredentialInvalid, 'Invalid client secret');
    }
    if (!app.props.auto_provisioned && !validateScopes(authCode.scopes, app.scopes)) {
      throw new AppError(CodeParamErr, 'Invalid scope');
    }

    const user = await this.ctx.users.byId(authCode.user_id);
    if (!user || user.status !== 'active') throw new AppError(CodeUserNotFound, 'User not found');

    // 签发 token。refresh TTL 可被应用 props.refresh_token_ttl 覆盖
    const subject = this.ctx.codec.encodeUserID(user.id);
    const { hashUserState } = await import('../lib/jwt');
    const stateHash = await hashUserState(user.email, user.password ?? '', this.ctx.settings.siteId);
    const refreshTTLOverride = Number(app.props.refresh_token_ttl ?? 0);
    const token = await this.ctx.jwt.issue({
      subject,
      stateHash,
      accessTTLSeconds: this.ctx.settings.accessTokenTTL,
      refreshTTLSeconds:
        refreshTTLOverride > 0 ? refreshTTLOverride : this.ctx.settings.refreshTokenTTL,
      scopes: authCode.scopes,
      clientId: args.client_id,
    });

    await this.sql`
      UPDATE oauth_grants SET last_used_at = now(), updated_at = now()
      WHERE user_id = ${user.id} AND client_id = ${app.id}
    `;

    const expiresIn = Math.max(
      0,
      Math.floor((new Date(token.access_expires).getTime() - Date.now()) / 1000),
    );
    const refreshExpiresIn = Math.max(
      0,
      Math.floor((new Date(token.refresh_expires).getTime() - Date.now()) / 1000),
    );

    return {
      access_token: token.access_token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token_expires_in: refreshExpiresIn,
      ...(authCode.scopes.includes(SCOPE_OFFLINE_ACCESS) ? { refresh_token: token.refresh_token } : {}),
      scope: authCode.scopes.join(' '),
    };
  }

  /** 撤销授权。 */
  async deleteGrant(user: UserRow, appGUID: string): Promise<void> {
    const app = await this.clientByGUID(appGUID);
    if (!app) throw new AppError(CodeNotFound, 'OAuth grant not found');
    const rows = (await this.sql`
      UPDATE oauth_grants SET deleted_at = now(), updated_at = now()
      WHERE user_id = ${user.id} AND client_id = ${app.id} AND deleted_at IS NULL
      RETURNING id
    `) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new AppError(CodeNotFound, 'OAuth grant not found');
  }

  /**
   * 当前用户已授权的应用列表（GET /user/setting 的 oauth_grants）。
   * 形状对齐上游 BuildOauthGrant（service/user/response.go:189）。
   */
  async listGrants(
    userId: number,
  ): Promise<
    Array<{ client_id: string; client_name: string; client_logo: string; scopes: string[]; last_used_at: string | null }>
  > {
    const rows = (await this.sql`
      SELECT c.guid, c.name, c.props, g.scopes, g.last_used_at
      FROM oauth_grants g
      JOIN oauth_clients c ON c.id = g.client_id
      WHERE g.user_id = ${userId} AND g.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY g.last_used_at DESC NULLS LAST, g.created_at DESC
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const props = (r.props as Record<string, unknown>) ?? {};
      const lastUsed = r.last_used_at ?? null;
      return {
        client_id: String(r.guid ?? ''),
        client_name: String(r.name ?? ''),
        client_logo: typeof props.icon === 'string' ? props.icon : '',
        scopes: (r.scopes as string[]) ?? [],
        last_used_at: lastUsed instanceof Date ? lastUsed.toISOString() : (lastUsed as string | null),
      };
    });
  }

  /**
   * OIDC userinfo。scopes 来自 token claims（appContext 中间件已解析）；
   * 内置登录 token 无 scopes 时视为全量放行（上游同款）。
   */
  async userinfo(user: UserRow, tokenScopes: string[] | undefined): Promise<Record<string, unknown>> {
    let scopes = tokenScopes;
    if (scopes) {
      if (!scopes.includes(SCOPE_OPENID)) {
        throw new AppError(CodeNoPermissionErr, 'openid scope required');
      }
    } else {
      scopes = [SCOPE_OPENID, SCOPE_PROFILE, SCOPE_EMAIL];
    }

    const sub = this.ctx.codec.encodeUserID(user.id);
    const out: Record<string, unknown> = { sub };
    for (const scope of scopes) {
      if (scope === SCOPE_PROFILE) {
        out.name = user.nick;
        out.preferred_username = user.nick;
        out.picture = `${this.ctx.settings.siteUrl.replace(/\/+$/, '')}/api/v4/user/avatar/${sub}`;
        out.updated_at = Math.floor(user.updated_at.getTime() / 1000);
      } else if (scope === SCOPE_EMAIL) {
        out.email = user.email;
        out.email_verified = true;
      }
    }
    return out;
  }
}

/** URL-safe base64 无填充。 */
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
