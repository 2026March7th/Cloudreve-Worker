/**
 * 会话路由。对应 Cloudreve v4 `routers/router.go` 的 session 分组。
 *
 *   POST   /api/v4/session/token           登录
 *   POST   /api/v4/session/token/refresh   刷新
 *   DELETE /api/v4/session/token           注销
 *   GET    /api/v4/session/prepare         登录前置检查
 *
 * 原版 `/session/token/2fa` 与 WebAuthn 相关端点在边缘版未实现：
 * 前者需要 2FA 秘钥轮转，后者需要 WebAuthn 服务端库（见 README「未实现」）。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { UserService } from '../services/user';
import { AppError, CodeFeatureNotEnabled, Err } from '../lib/errors';
import { verifyCaptcha } from './site';

export const sessionRoutes = new Hono<AppBindings>();

sessionRoutes.post('/token', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    captcha?: string;
    ticket?: string;
  };

  if (!body.email || !body.password) {
    return c.json(fail(c, Err.param('Email and password are required')) as never);
  }
  if (body.password.length < 4 || body.password.length > 128) {
    return c.json(fail(c, Err.param('Password length must be between 4 and 128')) as never);
  }

  // 登录验证码（站点开启时才校验）
  if (ctx.settings.loginCaptcha) {
    const passed = await verifyCaptcha(c.env, body.ticket, body.captcha);
    if (!passed) {
      return c.json(fail(c, new AppError(40026, 'CAPTCHA verification failed')) as never);
    }
  }

  try {
    const result = await new UserService(ctx).login(body.email, body.password);
    return c.json(ok(c, result) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

sessionRoutes.post('/token/refresh', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { refresh_token?: string };
  if (!body.refresh_token) {
    return c.json(fail(c, Err.param('refresh_token is required')) as never);
  }
  try {
    const token = await new UserService(ctx).refresh(body.refresh_token);
    return c.json(ok(c, token) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

sessionRoutes.delete('/token', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { refresh_token?: string };
  try {
    if (body.refresh_token) {
      await new UserService(ctx).logout(body.refresh_token);
    }
    // 原版注销成功返回空字符串
    return c.json(ok(c, '') as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

sessionRoutes.get('/prepare', async (c) => {
  const ctx = ctxOf(c);
  const email = c.req.query('email');
  if (!email) {
    return c.json(fail(c, Err.param('email is required')) as never);
  }
  const user = await ctx.users.byEmail(email);
  return c.json(
    ok(c, {
      // 边缘版不支持 Passkey 登录，恒为 false
      webauthn_enabled: false,
      // 用户存在且设置了密码
      password_enabled: Boolean(user?.password),
    }) as never,
  );
});

/** 未实现的认证方式，统一返回「功能未开启」。 */
sessionRoutes.all('/token/2fa', (c) =>
  c.json(fail(c, new AppError(CodeFeatureNotEnabled, 'Two-factor authentication is not implemented')) as never),
);
sessionRoutes.all('/authn', (c) =>
  c.json(fail(c, new AppError(CodeFeatureNotEnabled, 'Passkey authentication is not implemented')) as never),
);
