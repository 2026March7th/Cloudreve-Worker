/**
 * 设备路由 —— 目前只有 WebDAV 账号管理。
 *
 * 挂载点注意：上游 `routers/router.go:1292` 的 devices 分组挂在 **v4 根**
 * （`auth := v4.Group("")`），不是 user 分组下，所以真实路径是
 * `/api/v4/devices/dav`。放错父分组前端会拿到 404。
 *
 * 对应上游 `service/setting/webdav.go` 的四个服务：
 *   GET    /api/v4/devices/dav       列出账号（游标分页）
 *   PUT    /api/v4/devices/dav       创建（密码由服务端生成，随响应返回一次）
 *   PATCH  /api/v4/devices/dav/:id   更新（不改密码）
 *   DELETE /api/v4/devices/dav/:id   删除
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { URI } from '../services/uri';
import { AppError, Err } from '../lib/errors';
import { BooleanSet, GroupPermission } from '../lib/boolset';
import { randomString } from '../lib/crypto';
import type { HashIDCodec } from '../lib/hashid';
import type { DavAccountRow } from '../db/repo';

export const devicesRoutes = new Hono<AppBindings>();

/** 位号与上游 `types.DavAccountReadOnly/Proxy/DisableSysFiles`（iota 顺序）一致。 */
const DAV_OPT_READONLY = 0;
const DAV_OPT_PROXY = 1;
const DAV_OPT_DISABLE_SYS_FILES = 2;

/** 把请求体的三个开关转成位集字节。proxy 需要组权限（上游同款校验）。 */
function davOptionsFrom(
  body: { readonly?: boolean; proxy?: boolean; disable_sys_files?: boolean },
  canProxy: boolean,
): Uint8Array {
  const bs = new BooleanSet();
  if (body.readonly) bs.set(DAV_OPT_READONLY, true);
  if (body.proxy && canProxy) bs.set(DAV_OPT_PROXY, true);
  if (body.disable_sys_files) bs.set(DAV_OPT_DISABLE_SYS_FILES, true);
  return bs.toBytes();
}

function davAccountToResponse(codec: HashIDCodec, row: DavAccountRow) {
  const bs = row.options instanceof Uint8Array ? new BooleanSet(row.options) : new BooleanSet();
  return {
    id: codec.encodeDavAccountID(row.id),
    created_at: row.created_at.toISOString(),
    name: row.name,
    uri: row.uri,
    password: row.password,
    options: bs.toBase64(),
  };
}

/** 校验账号 URI：只允许 my / share 两种文件系统。对应上游 validateAndGetBs。 */
function validateDavUri(raw: string): void {
  let parsed: URI;
  try {
    parsed = URI.parse(raw);
  } catch {
    throw Err.param('Invalid URI');
  }
  if (parsed.fsType !== 'my' && parsed.fsType !== 'share') {
    throw Err.param('Invalid URI');
  }
}

devicesRoutes.get('/dav', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const pageSize = Math.max(10, Math.min(100, Number(c.req.query('page_size') ?? 20) || 20));
  const page = Math.max(0, Number(c.req.query('next_page_token') ?? 0) || 0);

  const { accounts, total } = await ctx.davAccounts.list({
    ownerId: ctx.user.id,
    page,
    pageSize,
  });
  const hasMore = (page + 1) * pageSize < total;
  return c.json(
    ok(c, {
      accounts: accounts.map((a) => davAccountToResponse(ctx.codec, a)),
      pagination: {
        page,
        page_size: pageSize,
        total_items: total,
        next_page_token: hasMore ? String(page + 1) : undefined,
      },
    }) as never,
  );
});

devicesRoutes.put('/dav', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    uri?: string;
    readonly?: boolean;
    proxy?: boolean;
    disable_sys_files?: boolean;
  };
  if (!body.name || !body.uri) {
    return c.json(fail(c, Err.param('name and uri are required')) as never);
  }
  try {
    // 上游 validateAndGetBs：用户组没开 WebDAV 就不能建账号
    if (!ctx.groupPermissions.enabled(GroupPermission.WebDAV)) {
      throw new AppError(40007, 'WebDAV is not enabled for this user group');
    }
    validateDavUri(body.uri);
    const account = await ctx.davAccounts.create({
      ownerId: ctx.user.id,
      name: body.name,
      uri: body.uri,
      password: randomString(32),
      options: davOptionsFrom(body, ctx.groupPermissions.enabled(GroupPermission.WebDAVProxy)),
    });
    return c.json(ok(c, davAccountToResponse(ctx.codec, account)) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

devicesRoutes.patch('/dav/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const id = ctx.codec.decodeDavAccountID(c.req.param('id'));
  if (id === null) return c.json(fail(c, Err.param('Invalid account id')) as never);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    uri?: string;
    readonly?: boolean;
    proxy?: boolean;
    disable_sys_files?: boolean;
  };
  if (!body.name || !body.uri) {
    return c.json(fail(c, Err.param('name and uri are required')) as never);
  }
  try {
    const existing = await ctx.davAccounts.byIdAndUser(id, ctx.user.id);
    if (!existing) throw new AppError(40004, 'Account not exist');
    validateDavUri(body.uri);
    // 更新不改密码；proxy 开关更新时沿用创建时的权限校验
    const account = await ctx.davAccounts.update(id, {
      name: body.name,
      uri: body.uri,
      options: davOptionsFrom(body, ctx.groupPermissions.enabled(GroupPermission.WebDAVProxy)),
    });
    return c.json(ok(c, davAccountToResponse(ctx.codec, account)) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

devicesRoutes.delete('/dav/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const id = ctx.codec.decodeDavAccountID(c.req.param('id'));
  if (id === null) return c.json(fail(c, Err.param('Invalid account id')) as never);
  try {
    const existing = await ctx.davAccounts.byIdAndUser(id, ctx.user.id);
    if (!existing) throw new AppError(40004, 'Account not exist');
    await ctx.davAccounts.remove(id);
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});
