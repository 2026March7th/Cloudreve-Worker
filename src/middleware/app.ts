/**
 * 请求上下文中间件：装配 AppContext、解析当前用户、生成关联 ID。
 *
 * 对应原版的 `middleware.Session` + `middleware.CurrentUser`：
 *   - 从 `Authorization: Bearer <jwt>` 解析用户；
 *   - token 无效/过期时不报错，按未登录处理（由各路由自行要求登录）；
 *   - `Bearer Cr <sign>` 是 HMAC 签名，不走 JWT 解析。
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { Env } from '../env';
import { AppContext } from '../services/context';
import { loadSettings } from '../settings/provider';
import { HashIDCodec } from '../lib/hashid';
import { JWTService, TokenHeaderPrefix, TokenHeaderPrefixCr } from '../lib/jwt';
import type { UserWithGroup } from '../db/types';
import { UserRepo } from '../db/repo';

export interface AppBindings {
  Bindings: Env;
  Variables: {
    ctx: AppContext;
    correlationId: string;
  };
}

/** 路由处理函数里收到的 Hono 上下文类型。 */
export type AppRequest = Context<AppBindings>;

/** 带上关联 ID 与安全头。 */
export function securityHeaders(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  };
}

/** 从请求头解析当前用户。 */
async function resolveUser(env: Env, header: string | null): Promise<UserWithGroup | undefined> {
  if (!header) return undefined;
  // HMAC 签名请求不是 JWT，跳过
  if (header.startsWith(TokenHeaderPrefixCr)) return undefined;
  if (!header.startsWith(TokenHeaderPrefix)) return undefined;

  const tokenStr = header.slice(TokenHeaderPrefix.length);
  if (!tokenStr) return undefined;

  const settings = await loadSettings(env);
  const jwt = new JWTService(settings.secretKey);
  const claims = await jwt.verify(tokenStr);
  if (!claims || claims.token_type !== 'access') return undefined;

  const codec = new HashIDCodec(settings.hashIdSalt);
  const uid = codec.decodeUserID(claims.sub);
  if (uid === null) return undefined;

  return (await new UserRepo(env).byIdWithGroup(uid)) ?? undefined;
}

/** 装配请求上下文。每个请求一次。 */
export function appContext(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const env = c.env;
    const correlationId = c.req.header('X-Correlation-ID') ?? crypto.randomUUID();
    c.set('correlationId', correlationId);

    const settings = await loadSettings(env);
    const codec = new HashIDCodec(settings.hashIdSalt);
    const jwt = new JWTService(settings.secretKey);

    let scopes: string[] | undefined;
    const header = c.req.header('Authorization') ?? null;
    const user = await resolveUser(env, header);

    if (user && header?.startsWith(TokenHeaderPrefix)) {
      const claims = await jwt.verify(header.slice(TokenHeaderPrefix.length));
      // 只有 OAuth 客户端签发的 token 才带 scope，内置登录不受 scope 限制
      if (claims?.client_id) scopes = claims.scopes;
    }

    c.set('ctx', new AppContext(env, settings, codec, jwt, user));
    c.header('X-Correlation-ID', correlationId);

    await next();
  };
}

/** 取当前请求上下文。 */
export function ctxOf(c: Context<AppBindings>): AppContext {
  return c.get('ctx');
}

/** 取当前用户，未登录抛 401（由全局错误处理转成标准响应）。 */
export function requireUser(c: Context<AppBindings>): UserWithGroup {
  return ctxOf(c).requireUser();
}

export { TokenHeaderPrefix, TokenHeaderPrefixCr };
export type { Next };
