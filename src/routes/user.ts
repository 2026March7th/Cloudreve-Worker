/**
 * 用户路由。对应 Cloudreve v4 `routers/router.go` 的 user 分组。
 *
 *   POST   /api/v4/user                  注册
 *   GET    /api/v4/user/me               当前用户
 *   GET    /api/v4/user/info/:id         指定用户（脱敏）
 *   GET    /api/v4/user/capacity         容量
 *   GET    /api/v4/user/avatar/:id       头像
 *   GET    /api/v4/user/setting          用户设置
 *   PATCH  /api/v4/user/setting          修改设置
 *   PUT    /api/v4/user/setting/avatar   上传头像
 *   GET    /api/v4/user/search           搜索用户
 *   GET    /api/v4/user/shares/:id       某用户的公开分享
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { UserService } from '../services/user';
import { ShareService } from '../services/share';
import { FileSystemService } from '../services/fs';
import { AppError, CodeFeatureNotEnabled, Err } from '../lib/errors';
import { verifyCaptcha } from './site';

export const userRoutes = new Hono<AppBindings>();

/** 注册 */
userRoutes.post('/', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    language?: string;
    captcha?: string;
    ticket?: string;
  };

  if (!ctx.settings.registerEnabled) {
    return c.json(fail(c, new AppError(40019, 'Registration is not enabled')) as never);
  }
  if (!body.email || !body.password) {
    return c.json(fail(c, Err.param('Email and password are required')) as never);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
    return c.json(fail(c, Err.param('Invalid email address')) as never);
  }
  if (body.password.length < 6 || body.password.length > 128) {
    return c.json(fail(c, Err.param('Password length must be between 6 and 128')) as never);
  }
  if (ctx.settings.regCaptcha) {
    const passed = await verifyCaptcha(c.env, body.ticket, body.captcha);
    if (!passed) {
      return c.json(fail(c, new AppError(40026, 'CAPTCHA verification failed')) as never);
    }
  }

  try {
    const result = await new UserService(ctx).register(body.email, body.password);
    // 需要邮件激活时返回 203（原版 CodeNotFullySuccess）
    if (result.needActivation) {
      const { okWithCode } = await import('../lib/response');
      return c.json(okWithCode(c, 203) as never);
    }
    return c.json(ok(c, result.user) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

/** 当前用户 */
userRoutes.get('/me', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  return c.json(ok(c, await new UserService(ctx).buildUserResponse(ctx.user, true)) as never);
});

/** 指定用户（脱敏） */
userRoutes.get('/info/:id', async (c) => {
  const ctx = ctxOf(c);
  const uid = ctx.codec.decodeUserID(c.req.param('id'));
  if (uid === null) return c.json(fail(c, Err.userNotFound()) as never);
  const user = await ctx.users.byId(uid);
  if (!user) return c.json(fail(c, Err.userNotFound()) as never);

  const self = ctx.user?.id === uid;
  const service = new UserService(ctx);
  const res = await service.buildUserResponse(user, self);
  if (!self) res.avatar = service.buildAvatarUrl(user);
  return c.json(ok(c, res) as never);
});

/** 容量 */
userRoutes.get('/capacity', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const capacity = await new UserService(ctx).capacity();
  return c.json(
    ok(c, {
      total: capacity.total,
      used: capacity.used,
    }) as never,
  );
});

/** 头像 */
userRoutes.get('/avatar/:id', async (c) => {
  const ctx = ctxOf(c);
  const avatar = await new UserService(ctx).getAvatar(c.req.param('id'));
  if (!avatar) {
    // 没有上传过头像时重定向到 gravatar（原版行为）
    const uid = ctx.codec.decodeUserID(c.req.param('id'));
    const user = uid !== null ? await ctx.users.byId(uid) : null;
    if (!user) return c.json(fail(c, Err.userNotFound()) as never);
    return c.redirect(new UserService(ctx).buildAvatarUrl(user), 302);
  }
  return new Response(avatar.body, {
    headers: {
      'Content-Type': avatar.contentType,
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

/** 用户设置 */
userRoutes.get('/setting', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const settings = ctx.user.settings ?? {};
  return c.json(
    ok(c, {
      version_retention_enabled: settings.version_retention === true,
      version_retention_ext: settings.version_retention_ext ?? [],
      version_retention_max: settings.version_retention_max ?? 0,
      // 原版字段名的拼写就是 paswordless（少一个 s），保持不变
      paswordless: !ctx.user.password,
      two_fa_enabled: Boolean(ctx.user.two_factor_secret),
      passkeys: [],
      disable_view_sync: settings.disable_view_sync === true,
      share_links_in_profile: settings.share_links_in_profile ?? '',
      oauth_grants: [],
    }) as never,
  );
});

userRoutes.patch('/setting', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const res = await new UserService(ctx).updateSettings({
      nick: body.nick as string | undefined,
      language: body.language as string | undefined,
      preferred_theme: body.preferred_theme as string | undefined,
      version_retention: body.version_retention_enabled as boolean | undefined,
      version_retention_ext: body.version_retention_ext as string[] | undefined,
      version_retention_max: body.version_retention_max as number | undefined,
      current_password: body.current_password as string | undefined,
      new_password: body.new_password as string | undefined,
      disable_view_sync: body.disable_view_sync as boolean | undefined,
      share_links_in_profile: body.share_links_in_profile as string | undefined,
    });
    return c.json(ok(c, res) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

/** 上传头像 */
userRoutes.put('/setting/avatar', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const contentType = c.req.header('Content-Type') ?? 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    return c.json(fail(c, Err.param('Avatar must be an image')) as never);
  }
  const body = await c.req.arrayBuffer();
  try {
    await new UserService(ctx).uploadAvatar(body, contentType);
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

/** 搜索用户 */
userRoutes.get('/search', async (c) => {
  const ctx = ctxOf(c);
  const keyword = c.req.query('keyword') ?? '';
  if (!keyword) return c.json(ok(c, []) as never);
  return c.json(ok(c, await new UserService(ctx).search(keyword)) as never);
});

/** 某用户的公开分享 */
userRoutes.get('/shares/:id', async (c) => {
  const ctx = ctxOf(c);
  const uid = ctx.codec.decodeUserID(c.req.param('id'));
  if (uid === null) return c.json(fail(c, Err.userNotFound()) as never);
  const user = await ctx.users.byId(uid);
  if (!user) return c.json(fail(c, Err.userNotFound()) as never);

  const settings = user.settings ?? {};
  // 用户可以选择隐藏公开分享（原版 ProfileHideShare）
  if (settings.share_links_in_profile === 'hide_share') {
    return c.json(ok(c, { shares: [], pagination: { page: 0, page_size: 0, total_items: 0 } }) as never);
  }
  if (settings.profile_off) {
    return c.json(fail(c, new AppError(404, 'Profile is disabled')) as never);
  }

  const pageSize = Math.min(Number(c.req.query('page_size') ?? 20) || 20, 100);
  const service = new ShareService(ctx, new FileSystemService(ctx));

  // 对应原版 `ListShareService.ListInUserProfile`：
  //   - `share_links_in_profile` 为 public_only（默认）时只列无密码分享；
  //   - 非本人查看 → unlocked / isOwner 都是 false，size 会被抹成 0。
  const publicOnly = (settings.share_links_in_profile ?? 'public_only') !== 'share_all';
  const res = await service.list({
    ownerId: uid,
    page: 0,
    pageSize,
    orderBy: 'created_at',
    orderDirection: 'desc',
    asOwner: ctx.user?.id === uid,
    publicOnly,
  });

  return c.json(ok(c, res) as never);
});

/** 发送密码重置邮件 —— 边缘版没有邮件服务，改为返回「未启用」。 */
userRoutes.post('/reset', (c) =>
  c.json(
    fail(c, new AppError(CodeFeatureNotEnabled, 'Email delivery is not configured in the edge build')) as never,
  ),
);

/** 通过令牌重置密码 */
userRoutes.patch('/reset/:id', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { password?: string; secret?: string };
  if (!body.password || !body.secret) {
    return c.json(fail(c, Err.param('password and secret are required')) as never);
  }
  try {
    const res = await new UserService(ctx).resetPassword(c.req.param('id'), body.secret, body.password);
    return c.json(ok(c, res) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

/** 邮件激活 —— 边缘版不支持邮件，直接返回未启用。 */
userRoutes.get('/activate/:id', (c) =>
  c.json(
    fail(c, new AppError(CodeFeatureNotEnabled, 'Email activation is not supported in the edge build')) as never,
  ),
);
