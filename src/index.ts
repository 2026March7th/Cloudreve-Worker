/**
 * Cloudreve Edge —— Worker 入口。
 *
 * 路由挂载与原版 `routers/router.go` 对齐：
 *   /api/v4/site/*     站点配置
 *   /api/v4/session/*  登录 / 刷新 / 注销
 *   /api/v4/user/*     用户与个人设置
 *   /api/v4/file/*     文件与上传下载
 *   /api/v4/share/*    分享
 *   /api/v4/admin/*    管理后台
 *   /api/v4/workflow/* 任务流（打包 / 远程下载）
 *   /s/:id             分享短链（302）
 *   /f/:id/:name       文件直链（302）
 *
 * 本 Worker 只提供后端；前端一律用官方前端（见下方「前端」一节）。
 * 所有业务错误都以 HTTP 200 + `{code, msg}` 返回，与原版一致。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { Env } from './env';
import { appContext, ctxOf, type AppBindings } from './middleware/app';
import { fail, ok } from './lib/response';
import { AppError, CodeNotFound } from './lib/errors';
import { ensureSettings, loadSettings } from './settings/provider';
import { provision } from './db/provision';
import { HashIDCodec } from './lib/hashid';
import { JWTService } from './lib/jwt';
import { AppContext } from './services/context';
import { siteRoutes } from './routes/site';
import { sessionRoutes } from './routes/session';
import { userRoutes } from './routes/user';
import { fileRoutes } from './routes/file';
import { shareRoutes } from './routes/share';
import { adminRoutes } from './routes/admin';
import { workflowRoutes } from './routes/workflow';
import { callbackRoutes } from './routes/callback';
import { devicesRoutes } from './routes/devices';
import { davRoutes } from './routes/dav';
import { DownloadService } from './services/download';
import { FileSystemService } from './services/fs';
import { ShareService } from './services/share';

const BOOTSTRAP_FLAG = 'bootstrap:done:v2';
/** 自举失败后的冷却键（20 秒 TTL）：期间请求直接快速失败，不再重放自举。 */
const BOOTSTRAP_COOLDOWN = 'bootstrap:cooldown:v1';
/** 同一 isolate 内的并发请求共享一次自举。 */
let bootstrapPromise: Promise<void> | null = null;

const app = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// 全局中间件
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  // 冷启动自举：自动建表、播种系统组与默认策略、补齐设置表。
  // 三件事都幂等，用 KV 标记避免每个请求都打一遍数据库。
  // 失败有 20 秒冷却期：期间的请求直接回 503，避免所有请求同时重放
  // 自举把 Neon 打出限流（那正是「站点配置加载失败 429」的根源）。
  const bootstrapped = await c.env.KV.get(BOOTSTRAP_FLAG);
  if (!bootstrapped) {
    if (await c.env.KV.get(BOOTSTRAP_COOLDOWN)) {
      return c.json(
        { code: 50006, msg: '站点正在初始化（刚部署或数据库暂时不可用），请几秒后刷新重试' },
        503,
      ) as never;
    }
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        await provision(c.env);
        await ensureSettings(c.env);
        await c.env.KV.put(BOOTSTRAP_FLAG, '1');
      })().catch(async (err) => {
        bootstrapPromise = null;
        try {
          await c.env.KV.put(BOOTSTRAP_COOLDOWN, '1', { expirationTtl: 20 });
        } catch {
          /* KV 也不可用时只能让下一个请求再试 */
        }
        throw err;
      });
    }
    await bootstrapPromise;
  }
  await next();
});

/**
 * API 跨域。原版默认**不开**跨域（配置项 AllowOrigins 为 UNSET 时不挂 CORS
 * 中间件，见 `routers/router.go` 的 initCORS），要用得显式配。边缘版沿用同一策略：
 * 只有 `CORS_ALLOW_ORIGINS` 里列出的源才会拿到 ACAO 头，未配置就等于关闭。
 *
 * 官方前端与 Worker 同源部署时不需要开这个。
 */
app.use('/api/*', cors({
  origin: (origin: string, c: Context<AppBindings>) => {
    const allowed = (c.env.CORS_ALLOW_ORIGINS ?? '')
      .split(',')
      .map((o: string) => o.trim())
      .filter(Boolean);
    if (allowed.length === 0) return '';
    // 没有 Origin 头（同源请求 / curl）时不必回 ACAO
    if (!origin) return '';
    return allowed.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Range', 'If-Range', 'X-Correlation-ID'],
  exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Disposition', 'ETag'],
  credentials: true,
  maxAge: 86400,
}));

app.use('*', appContext());

// ---------------------------------------------------------------------------
// 业务路由
// ---------------------------------------------------------------------------

app.route('/api/v4/site', siteRoutes);
app.route('/api/v4/session', sessionRoutes);
app.route('/api/v4/user', userRoutes);
app.route('/api/v4/file', fileRoutes);
app.route('/api/v4/share', shareRoutes);
app.route('/api/v4/admin', adminRoutes);
app.route('/api/v4/workflow', workflowRoutes);

/**
 * 上传回调。原版在 `/api/v4/callback` 下按驱动分成 9 个子路径，边缘版只实现
 * OneDrive 一条 —— 它走客户端直传，没有回调就无法完成「实体转正 + 容量记账」。
 * 其余驱动的回调返回 40019（见 `routes/callback.ts`）。
 *
 * 鉴权靠路径里的 callback secret，不走登录中间件（与原版一致）。
 */
app.route('/api/v4/callback', callbackRoutes);
app.route('/api/v4/devices', devicesRoutes);
app.route('/dav', davRoutes);

// ---------------------------------------------------------------------------
// 内容跨域。对应原版 `middleware.ContentCORS()`，只挂在两个「内容」路由组上：
//   - /api/v4/file/content/:id/:speed/:name   实体内容（预览 / 下载）
//   - /f/:id/:name                            文件直链跳转
// 这三个头是给 <video>/<audio> 的 Range 请求用的，**不带凭据**。
// ---------------------------------------------------------------------------

const contentCors = cors({
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Range', 'If-Range', 'Authorization', 'Content-Type'],
  exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Disposition', 'ETag'],
  credentials: false,
});

app.use('/api/v4/file/content/*', contentCors);
app.use('/f/*', contentCors);

// ---------------------------------------------------------------------------
// 短链与直链
// ---------------------------------------------------------------------------

/**
 * 分享短链。原版 `sharesvc.ShortLinkRedirectService` 不查库，直接把
 * `cloudreve://<id>[:password]@share` 拼进前端地址重定向；分享不存在这类情况
 * 交给前端展示「链接失效」。这里保持一致 —— 失败也照常跳，不吞错误码。
 */
app.get('/s/:id', (c) => {
  const ctx = ctxOf(c);
  const share = new ShareService(ctx, new FileSystemService(ctx));
  const query = new URL(c.req.url).searchParams;
  return c.redirect(share.shortLinkRedirect(c.req.param('id'), undefined, query), 302);
});

app.get('/s/:id/:password', (c) => {
  const ctx = ctxOf(c);
  const share = new ShareService(ctx, new FileSystemService(ctx));
  const query = new URL(c.req.url).searchParams;
  return c.redirect(share.shortLinkRedirect(c.req.param('id'), c.req.param('password'), query), 302);
});

/**
 * 文件直链。原版 `AnonymousPermLink` 会用 `c.Redirect(302, ...)` 跳到存储后端
 * 的真实地址；失败时**不是** 200 信封，而是 `c.JSON(404, envelope)`
 * （见 `routers/controllers/file.go`），这里照做。
 */
app.get('/f/:id/:name', async (c) => {
  const ctx = ctxOf(c);
  const service = new FileSystemService(ctx);
  const download = new DownloadService(ctx, service);
  try {
    const target = await download.visitDirectLink(c.req.param('id'));
    return c.redirect(target, 302);
  } catch (e) {
    return c.json(fail(c, e) as never, 404);
  }
});

// ---------------------------------------------------------------------------
// 前端
//
// 本 Worker 只是后端，**不内置任何自研前端**。官方前端（Cloudreve/Frontend
// 的 v4 构建产物）有两种接法，见 README「接入官方前端」：
//
//   A. 推荐：在 wrangler.toml 里配 `[assets]`，把官方前端构建产物目录指过去。
//      静态资源与 SPA 回落由平台的资源层处理，本函数不会被调用。
//   B. 官方前端单独部署（Cloudflare Pages 等），把 FRONTEND_URL 指过去，
//      这里做一次原样反代，保证同源、Cookie 与 /api 路径都不出问题。
// ---------------------------------------------------------------------------

/** 非 /api 请求的兜底：优先反代到 FRONTEND_URL，其次交给静态资源绑定。 */
async function serveFrontend(c: Context<AppBindings>): Promise<Response> {
  const frontendUrl = c.env.FRONTEND_URL?.replace(/\/+$/, '');
  if (frontendUrl) {
    const incoming = new URL(c.req.url);
    const target = `${frontendUrl}${incoming.pathname}${incoming.search}`;
    const proxied = new Request(target, c.req.raw);
    // 让官方前端自己判断协议/主机，避免把 Worker 的 Host 传下去导致回跳错地址
    proxied.headers.delete('host');
    return fetch(proxied);
  }

  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  return c.text(
    'Cloudreve Edge 后端已就绪，但没有配置前端。\n' +
      '请二选一：配置 wrangler.toml 的 [assets] 指向官方前端构建产物，' +
      '或设置 FRONTEND_URL 指向已部署的官方前端。\n' +
      'API 入口：/api/v4/site/ping\n',
    404,
  );
}

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------

app.notFound(async (c) => {
  // API 路径保持信封格式；其它路径交给官方前端（前端路由由前端自己处理）
  if (c.req.path.startsWith('/api/')) {
    return c.json(fail(c, new AppError(CodeNotFound, 'API endpoint not found')) as never);
  }
  return serveFrontend(c);
});

app.onError((err, c) => {
  // 未预期的异常统一转成标准信封，避免把堆栈暴露给客户端
  const wrapped = err instanceof AppError ? err : new AppError(50005, 'Internal server error', err);
  return c.json(fail(c, wrapped) as never);
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,
  /**
   * 定时清理（在 wrangler.toml 的 `[triggers] crons` 里配置后生效）。
   *
   * 目前只做一件事：清掉回收站里已到期的项 —— 对应原版的队列任务
   * `trash_collector`，判定依据是软删除时写入的 `sys:expected_collect_time`。
   * KV 里的上传会话 / 验证码靠 TTL 自动过期，不需要在这里处理。
   */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // 自举没完成（刚部署、还没人访问过）时 settings 表可能还不存在，
    // 定时任务直接跳过 —— 第一次网页请求会完成自举。
    try {
      if (!(await env.KV.get(BOOTSTRAP_FLAG))) {
        console.log('trash collector: skipped (bootstrap not finished yet)');
        return;
      }
    } catch {
      // KV 都不可用就没什么可清理的，等下一轮
      return;
    }

    try {
      const settings = await loadSettings(env);
      const appCtx = new AppContext(
        env,
        settings,
        new HashIDCodec(settings.hashIdSalt),
        new JWTService(settings.secretKey),
      );
      const removed = await new FileSystemService(appCtx).purgeExpiredTrash();
      if (removed > 0) {
        console.log(`trash collector: purged ${removed} expired item(s)`);
      }
    } catch (e) {
      // 定时任务不该因为一次失败就中断后续调度；这里只记日志，不向上抛。
      // 部分错误对象（跨序列化边界）会丢 message，把全部字段 dump 出来
      // 才能在日志里看到真实原因，而不是只剩一行堆栈帧。
      console.error('trash collector failed', describeError(e));
    }
  },
};

/** 把任意抛出的值整理成带完整上下文的字符串，专治没有 message 的错误对象。 */
function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause !== undefined ? ` | cause: ${describeError(e.cause)}` : '';
    const extra = Object.getOwnPropertyNames(e)
      .filter((k) => !['stack', 'message', 'cause'].includes(k))
      .map((k) => `${k}=${JSON.stringify((e as unknown as Record<string, unknown>)[k])}`)
      .join(', ');
    return `${e.name}: ${e.message || '(no message)'}${extra ? ` | ${extra}` : ''}${cause}\n${e.stack ?? ''}`;
  }
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

