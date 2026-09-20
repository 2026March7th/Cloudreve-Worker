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
 *   GET    /api/v4/user/setting/2fa      初始化两步验证
 *   PUT    /api/v4/user/setting/avatar   上传头像
 *   GET    /api/v4/user/search           搜索用户
 *   GET    /api/v4/user/shares/:id       某用户的公开分享
 *   POST   /api/v4/user/reset            发送密码重置邮件
 *   PATCH  /api/v4/user/reset/:id        用令牌重置密码
 *   GET    /api/v4/user/activate/:id     邮件激活（需路径签名）
 *
 * WebDAV 账号管理已迁至 `routes/devices.ts`（上游 devices 是独立分组）。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { UserService } from '../services/user';
import { PasskeyService } from '../services/passkey';
import { ShareService } from '../services/share';
import { FileSystemService } from '../services/fs';
import { AppError, CodeEmailSent, CodeNotFullySuccess, Err } from '../lib/errors';
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
    return fail(c, new AppError(40019, 'Registration is not enabled'));
  }
  if (!body.email || !body.password) {
    return fail(c, Err.param('Email and password are required'));
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
    return fail(c, Err.param('Invalid email address'));
  }
  if (body.password.length < 6 || body.password.length > 128) {
    return fail(c, Err.param('Password length must be between 6 and 128'));
  }
  if (ctx.settings.regCaptcha) {
    const passed = await verifyCaptcha(c.env, body.ticket, body.captcha);
    if (!passed) {
      return fail(c, new AppError(40026, 'CAPTCHA verification failed'));
    }
  }

  try {
    const result = await new UserService(ctx).register(body.email, body.password, body.language);
    const { okWithCode } = await import('../lib/response');
    switch (result.kind) {
      case 'needActivation':
        // 需要邮件激活 → 203（原版 CodeNotFullySuccess）
        return okWithCode(c, CodeNotFullySuccess);
      case 'resent':
        // 邮箱已存在但未激活，激活邮件已重发 → 40033（原版 CodeEmailSent）
        return fail(c, new AppError(CodeEmailSent, result.msg));
      default:
        return ok(c, result.user);
    }
  } catch (e) {
    return fail(c, e);
  }
});

/** 当前用户 */
userRoutes.get('/me', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  return ok(c, await new UserService(ctx).buildUserResponse(ctx.user, true));
});

/** 指定用户（脱敏） */
userRoutes.get('/info/:id', async (c) => {
  const ctx = ctxOf(c);
  const uid = ctx.codec.decodeUserID(c.req.param('id'));
  if (uid === null) return fail(c, Err.userNotFound());
  const user = await ctx.users.byId(uid);
  if (!user) return fail(c, Err.userNotFound());

  const self = ctx.user?.id === uid;
  const service = new UserService(ctx);
  const res = await service.buildUserResponse(user, self);
  if (!self) res.avatar = service.buildAvatarUrl(user);
  return ok(c, res);
});

/** 容量 */
userRoutes.get('/capacity', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const capacity = await new UserService(ctx).capacity();
  return ok(c, {
      total: capacity.total,
      used: capacity.used,
    });
});

/** 头像 */
userRoutes.get('/avatar/:id', async (c) => {
  const ctx = ctxOf(c);
  const avatar = await new UserService(ctx).getAvatar(c.req.param('id'));
  if (!avatar) {
    // 没有上传过头像时重定向到 gravatar（原版行为）
    const uid = ctx.codec.decodeUserID(c.req.param('id'));
    const user = uid !== null ? await ctx.users.byId(uid) : null;
    if (!user) return fail(c, Err.userNotFound());
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
  if (!ctx.user) return fail(c, Err.loginRequired());
  const settings = ctx.user.settings ?? {};
  return ok(c, {
      version_retention_enabled: settings.version_retention === true,
      version_retention_ext: settings.version_retention_ext ?? [],
      version_retention_max: settings.version_retention_max ?? 0,
      // 上游 Go 结构体字段写作 `Paswordless`（少一个 s），但 JSON tag 是完整的
      // `passwordless`（service/user/response.go:30），前端也按 `passwordless` 读。
      passwordless: !ctx.user.password,
      two_fa_enabled: Boolean(ctx.user.two_factor_secret),
      passkeys: await new PasskeyService(ctx, c.env, ctx.codec).list(ctx.user),
      disable_view_sync: settings.disable_view_sync === true,
      share_links_in_profile: settings.share_links_in_profile ?? '',
      upload_policy_id:
        settings.upload_policy_id != null
          ? ctx.codec.encodePolicyID(Number(settings.upload_policy_id))
          : '',
      oauth_grants: [],
    });
});

userRoutes.patch('/setting', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
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
      upload_policy_id: body.upload_policy_id as string | number | undefined,
      two_fa_enabled: body.two_fa_enabled as boolean | undefined,
      two_fa_code: body.two_fa_code as string | undefined,
    });
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 初始化两步验证：返回 TOTP 密钥原文（base32，无填充）。
 *
 * 前端 `get2FAInitSecret()` 直接拿这个串拼 `otpauth://totp/...` 生成二维码，
 * 所以响应体就是密钥本身，不套对象。密钥同时暂存进 KV（`2fa_init_{uid}`，
 * TTL 600 秒），等 `PATCH /user/setting` 带上 `two_fa_code` 确认后才写进账号。
 */
userRoutes.get('/setting/2fa', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  try {
    return ok(c, await new UserService(ctx).init2FA());
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * Passkey 管理。对应上游 `user.Group("authn")`（router.go:1255-1267），
 * 受站点设置 `authn_enabled` 门控。
 *
 *   PUT    生成创建选项（挑战暂存 KV）
 *   POST   验证 attestation 并落库
 *   DELETE ?id=<credentialID> 删除
 */
userRoutes.put('/authn', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const service = new PasskeyService(ctx, c.env, ctx.codec);
  try {
    return ok(c, await service.prepareRegister(ctx.user));
  } catch (e) {
    return fail(c, e);
  }
});

userRoutes.post('/authn', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { response?: string; name?: string };
  if (!body.response || !body.name) {
    return fail(c, Err.param('response and name are required'));
  }
  const service = new PasskeyService(ctx, c.env, ctx.codec);
  try {
    return ok(c, await service.finishRegister(ctx.user, { response: body.response, name: body.name }));
  } catch (e) {
    return fail(c, e);
  }
});

userRoutes.delete('/authn', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const credentialId = c.req.query('id');
  if (!credentialId) return fail(c, Err.param('id is required'));
  const service = new PasskeyService(ctx, c.env, ctx.codec);
  try {
    await service.remove(ctx.user, credentialId);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 上传头像 */
userRoutes.put('/setting/avatar', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const contentType = c.req.header('Content-Type') ?? 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    return fail(c, Err.param('Avatar must be an image'));
  }
  const body = await c.req.arrayBuffer();
  try {
    await new UserService(ctx).uploadAvatar(body, contentType);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 某用户的公开分享 */
userRoutes.get('/shares/:id', async (c) => {
  const ctx = ctxOf(c);
  const uid = ctx.codec.decodeUserID(c.req.param('id'));
  if (uid === null) return fail(c, Err.userNotFound());
  const user = await ctx.users.byId(uid);
  if (!user) return fail(c, Err.userNotFound());

  const settings = user.settings ?? {};
  // 用户可以选择隐藏公开分享（原版 ProfileHideShare）
  if (settings.share_links_in_profile === 'hide_share') {
    return ok(c, { shares: [], pagination: { page: 0, page_size: 0, total_items: 0 } });
  }
  if (settings.profile_off) {
    return fail(c, new AppError(404, 'Profile is disabled'));
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

  return ok(c, res);
});

/**
 * 搜索用户（分享选择器等场景用）。
 * 对应上游 `user.GET("search")`（router.go:1248）→ `SearchActive`：
 * nick / email 模糊匹配、只搜活跃用户、上限 10 条、脱敏返回。
 */
userRoutes.get('/search', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const keyword = (c.req.query('keyword') ?? '').trim();
  if (keyword.length < 2) {
    return fail(c, Err.param('keyword must be at least 2 characters'));
  }
  try {
    const users = await ctx.users.searchActive(keyword, 10);
    const service = new UserService(ctx);
    return ok(
        c,
        users.map((u) => ({
          id: ctx.codec.encodeUserID(u.id),
          nickname: u.nick,
          avatar: service.buildAvatarUrl(u),
          created_at: u.created_at.toISOString(),
          email: u.email,
        })),
      );
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 发送密码重置邮件。对应上游 `routers/router.go:391 user.POST("reset")`。
 *
 * 原版这一步挂了 `CaptchaRequired`，决定权在看 `forget_captcha` 设置项
 * （注意不是注册用的 `reg_captcha`）。
 */
userRoutes.post('/reset', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    language?: string;
    captcha?: string;
    ticket?: string;
  };

  if (!body.email) {
    return fail(c, Err.param('Email is required'));
  }
  if (ctx.settings.forgetCaptcha) {
    const passed = await verifyCaptcha(c.env, body.ticket, body.captcha);
    if (!passed) {
      return fail(c, new AppError(40026, 'CAPTCHA verification failed'));
    }
  }

  try {
    await new UserService(ctx).sendResetEmail(body.email);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 通过令牌重置密码 */
userRoutes.patch('/reset/:id', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { password?: string; secret?: string };
  if (!body.password || !body.secret) {
    return fail(c, Err.param('password and secret are required'));
  }
  try {
    const res = await new UserService(ctx).resetPassword(c.req.param('id'), body.secret, body.password);
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 邮件激活。对应上游 `routers/router.go:399 user.GET("activate/:id")`。
 *
 * 上游在 handler 之前挂了 `SignRequired`，校验的是**路径签名**：
 * 前端 `/session/activate?id=&sign=` 里的 sign，是用后端 API 路径
 * `/api/v4/user/activate/<id>` 算出来的。签名通过才允许改状态——
 * 少了这一步，任何人猜到一个用户 id 就能把别人的账号激活。
 *
 * 这里用路由参数重新拼路径再校验，避免客户端传了百分号编码导致路径不等。
 */
userRoutes.get('/activate/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = c.req.param('id');
  try {
    const res = await new UserService(ctx).activate(
      id,
      c.req.query('sign') ?? '',
      `/api/v4/user/activate/${id}`,
    );
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});
