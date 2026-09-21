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
import { logAudit } from '../services/audit';
import { MailService } from '../services/mail';
import { loadSettings, type SettingsProvider } from '../settings/provider';
import { HashIDCodec } from '../lib/hashid';
import { JWTService, TokenHeaderPrefix, TokenHeaderPrefixCr } from '../lib/jwt';
import type { UserWithGroup } from '../db/types';
import { UserRepo } from '../db/repo';

export interface AppBindings {
  Bindings: Env;
  Variables: {
    ctx: AppContext;
    correlationId: string;
    /** WebDAV Basic Auth 验证通过的账号（仅 /dav 路由使用） */
    davAccount: import('../db/repo').DavAccountRow;
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

/** 从请求头解析当前用户。settings 由调用方复用，避免重复打 KV/DB。 */
async function resolveUser(
  env: Env,
  header: string | null,
  settings: SettingsProvider,
): Promise<UserWithGroup | undefined> {
  if (!header) return undefined;
  // HMAC 签名请求不是 JWT，跳过
  if (header.startsWith(TokenHeaderPrefixCr)) return undefined;
  if (!header.startsWith(TokenHeaderPrefix)) return undefined;

  const tokenStr = header.slice(TokenHeaderPrefix.length);
  if (!tokenStr) return undefined;

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
    const user = await resolveUser(env, header, settings);

    if (user && header?.startsWith(TokenHeaderPrefix)) {
      const claims = await jwt.verify(header.slice(TokenHeaderPrefix.length));
      // 只有 OAuth 客户端签发的 token 才带 scope，内置登录不受 scope 限制
      if (claims?.client_id) scopes = claims.scopes;
    }

    // 购买用户组到期惰性回退（edge 自建 Pro 功能）：没有后台定时任务，
    // 就在解析出用户后检查一次；过期则回退到购买前的组并清掉记录。
    // 失败静默吞掉——这里出错不该让整个请求挂掉。
    if (user?.settings?.group_pack) {
      const pack = user.settings.group_pack;
      const expired = pack.expire_at && new Date(pack.expire_at).getTime() <= Date.now();
      if (expired) {
        try {
          const repo = new UserRepo(env);
          const settings = { ...user.settings, group_pack: null };
          await repo.updateGroup(user.id, pack.prev_group_id);
          await repo.updateSettings(user.id, settings);
          user.group_users = pack.prev_group_id;
          user.settings = settings;
          const g = await repo.byIdWithGroup(user.id);
          if (g) {
            user.group = g.group;
          }
        } catch {
          // 回退失败保持现状，下个请求再试
        }
      }
    }

    const appCtx = new AppContext(env, settings, codec, jwt, user, scopes);
    // 后台任务挂钩：把「发信」这类不能阻塞响应、又不该丢的工作挂到
    // Workers 的 waitUntil 上（对应原版的常驻队列发信）。
    appCtx.setBackgroundHooks({
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      onQuotaExceeded: (u) => {
        // 原版 Pro 的 mail_exceed_quota_template：配额超出时发通知邮件。
        // KV 限频 24h/用户，否则一次批量上传能把邮箱塞爆。
        const kv = env.KV;
        if (!kv) return;
        c.executionCtx.waitUntil(
          (async () => {
            const key = `mail_exceed_quota_sent_${u.id}`;
            try {
              if (await kv.get(key)) return;
              await kv.put(key, '1', { expirationTtl: 86_400 });
              const mail = new MailService(appCtx);
              if (mail.available) await mail.sendExceedQuotaEmail(u);
              logAudit(appCtx, 'user_exceed_quota_notified', u.id);
            } catch {
              // 通知是尽力而为，任何失败都吞掉
            }
          })(),
        );
      },
    });
    c.set('ctx', appCtx);
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
