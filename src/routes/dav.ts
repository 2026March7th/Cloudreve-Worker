/**
 * WebDAV 协议服务端。对应上游 `pkg/webdav`（golang.org/x/net/webdav 的 fork）+
 * `routers/router.go:1344-1358` 的 `initWebDAV`。
 *
 * 鉴权与上游 `middleware/auth.go:104-176`（WebDAVAuth）一致：
 *   - Basic Auth，用户名 = WebDAV 账号名，密码 = 创建账号时生成的随机串；
 *   - OPTIONS 不需要鉴权；
 *   - 用户组必须开了 WebDAV 权限，否则 403；
 *   - 只读账号禁 DELETE/PUT/MKCOL/COPY/MOVE/LOCK/UNLOCK，403。
 *
 * 路径映射与上游 stripPrefix 一致：URL 里 `/dav/<相对路径>`，接在**账号 URI**
 * （如 `my:///` 或 `my:///docs`）后面。
 *
 * 支持的方法：OPTIONS / PROPFIND / GET / HEAD / PUT / MKCOL / DELETE / MOVE /
 * COPY / PROPPATCH / LOCK / UNLOCK。客户端覆盖 RaiDrive、Windows 映射网络驱动器、
 * rclone（webdav backend）、Cyberduck。
 *
 * 已知取舍（写在明处，别装没看见）：
 *   - `share://` 账号在挂载时按 403 处理：上游要 walk 分享树逐层校验，边缘版
 *     第一版只做 `my://`，有真实需求再补；
 *   - LOCK 是 KV 简化锁（够 Windows/RaiDrive 走完写流程），不是完整的 RFC 4918 锁系统。
 */
import { Hono } from 'hono';
import type { AppBindings, AppRequest } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { logAudit } from '../services/audit';
import { AppContext, permissionsOf } from '../services/context';
import { URI } from '../services/uri';
import { FileSystemService } from '../services/fs';
import { UploadService } from '../services/upload';
import type { FileRow } from '../db/types';
import type { DavAccountRow } from '../db/repo';
import { BooleanSet, GroupPermission, FileType } from '../lib/boolset';
import { CodeObjectExist } from '../lib/errors';
import { kvFor } from '../lib/kvRouter';

export const davRoutes = new Hono<AppBindings>();

/** URL 前缀。与上游 `pkg/webdav/webdav.go` 的 `davPrefix` 一致。 */
const DAV_PREFIX = '/dav';

/** 锁的默认时长（秒），客户端没给 Timeout 时用。 */
const LOCK_DEFAULT_TTL = 600;

/** 只读账号禁用的位号（DavAccountReadOnly）。 */
const DAV_OPT_READONLY = 0;

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

function parseBasicAuth(header: string | undefined): { name: string; password: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    return { name: decoded.slice(0, i), password: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

/** 只读账号禁用的方法。与上游 WebDAVAuth:166 的列表一致。 */
const WRITE_METHODS = new Set(['DELETE', 'PUT', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK']);

davRoutes.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase();

  const auth = parseBasicAuth(c.req.header('Authorization'));
  if (!auth) {
    // OPTIONS 不需要鉴权（上游同款豁免），其余要求 Basic Auth
    if (method === 'OPTIONS') return next();
    c.header('WWW-Authenticate', 'Basic realm="cloudreve"');
    return c.body(null, 401);
  }

  const ctx = ctxOf(c);
  const hit = await ctx.davAccounts.byNameAndPassword(auth.name, auth.password);
  if (!hit) {
    logAudit(ctx, 'webdav_login_failed', null, { name: auth.name });
    // Windows WebClient 收到没有 WWW-Authenticate 的 401 不会重试凭据
    c.header('WWW-Authenticate', 'Basic realm="cloudreve"');
    return c.body(null, 401);
  }

  const full = await ctx.users.byIdWithGroup(hit.account.owner_id);
  if (!full) return c.body(null, 401);
  if (!permissionsOf(full.group).enabled(GroupPermission.WebDAV)) return c.body(null, 403);

  // 只读账号禁写方法
  const opts = new BooleanSet(hit.account.options);
  if (opts.enabled(DAV_OPT_READONLY) && WRITE_METHODS.has(method)) {
    return c.body(null, 403);
  }

  // 用已验证的身份重建请求上下文（后续 handler 里的 requireUser 全部生效）
  c.set('ctx', new AppContext(ctx.env, ctx.settings, ctx.codec, ctx.jwt, full));
  c.set('davAccount', hit.account);
  await next();
});

/** 取当前请求的 WebDAV 账号（鉴权中间件已写入）。 */
function davAccountOf(c: AppRequest): DavAccountRow {
  return c.get('davAccount');
}

// ---------------------------------------------------------------------------
// 路径 → URI
// ---------------------------------------------------------------------------

/** URL pathname + 账号 URI → 目标 URI。账号 URI 只允许 my://（见文件头「已知取舍」）。 */
function targetUri(c: AppRequest): URI | null {
  const account = davAccountOf(c);
  const base = URI.tryParse(account.uri);
  if (!base || base.fsType !== 'my') return null;

  const raw = new URL(c.req.url).pathname;
  if (!raw.startsWith(DAV_PREFIX)) return null;
  let rel = raw.slice(DAV_PREFIX.length);
  rel = decodeURIComponent(rel);
  const joined = (base.path.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '')).replace(
    /\/{2,}/g,
    '/',
  );
  const target = base.withPath(joined === '' ? '/' : joined);
  // 路径穿越防护：URI 已归一化（会解析 `..`），因此解析后的路径必须仍位于
  // WebDAV 账号根（base.path）之内，否则可越权访问账号限定目录之外的文件
  // （与 CVE-2026-54563 同类）。账号根即 `my://` 时已在最顶层，无需限制。
  if (base.path !== '/' && target.path !== base.path && !target.path.startsWith(base.path + '/')) {
    return null;
  }
  return target;
}

// ---------------------------------------------------------------------------
// XML 工具
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** RFC 1123（HTTP-date）。 */
function httpDate(d: Date): string {
  return d.toUTCString();
}

/** 生成单条 <D:response>。isCollection 决定 resourcetype。 */
function davResponseXml(args: {
  href: string;
  displayName: string;
  isCollection: boolean;
  size: number;
  modifiedAt: Date;
  contentType?: string;
}): string {
  const props = [
    `<D:displayname>${escapeXml(args.displayName)}</D:displayname>`,
    `<D:getlastmodified>${httpDate(args.modifiedAt)}</D:getlastmodified>`,
    args.isCollection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    args.isCollection ? '' : `<D:getcontentlength>${args.size}</D:getcontentlength>`,
    args.isCollection
      ? ''
      : `<D:getcontenttype>${escapeXml(args.contentType ?? 'application/octet-stream')}</D:getcontenttype>`,
    `<D:creationdate>${args.modifiedAt.toISOString()}</D:creationdate>`,
    `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`,
  ]
    .filter(Boolean)
    .join('');
  return `<D:response><D:href>${escapeXml(args.href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
}

// ---------------------------------------------------------------------------
// 文件系统助手
// ---------------------------------------------------------------------------

async function openEntityStream(
  ctx: AppContext,
  file: FileRow,
  range: string | null,
): Promise<{
  body: ReadableStream;
  size: number;
  contentType?: string;
  contentRange?: string | null;
} | null> {
  if (!file.primary_entity) return null;
  const entity = await ctx.entities.byId(file.primary_entity);
  if (!entity) return null;
  const policy = await ctx.policies.byId(entity.storage_policy_entities);
  if (!policy) return null;
  return ctx.driverFor(policy).get(entity.source, range);
}

/** 判断行是否目录。必须用 type 位（file_children 指向父容器，文件/目录都非空）；根行兜底。 */
function isFolderRow(fs: FileSystemService, file: FileRow): boolean {
  return file.type === FileType.Folder || fs.isRootFolder(file);
}

/**
 * href：路径逐段百分号编码（中文/空格原样写进 XML 会让 Windows MrxDAV
 * 与请求 URL 对不上号），目录以 `/` 结尾（RFC 4918）。
 */
function hrefFor(target: URI, isDir: boolean): string {
  const encoded = target.path
    .split('/')
    .map((seg) => (seg === '' ? '' : encodeURIComponent(seg)))
    .join('/');
  return `${DAV_PREFIX}${encoded === '' ? '' : encoded}${isDir && !encoded.endsWith('/') ? '/' : ''}`;
}

davRoutes.on('OPTIONS', '*', (c) => {
  c.header('DAV', '1, 2');
  c.header(
    'Allow',
    'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
  );
  c.header('MS-Author-Via', 'DAV');
  return c.body(null, 200);
});

davRoutes.on('PROPFIND', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  const depthHeader = (c.req.header('Depth') ?? '1').trim();
  const depth = depthHeader === '0' ? 0 : 1; // RFC 4918：非法 Depth 按 1 处理（无限深不支持）

  const fs = new FileSystemService(ctx);
  let file: FileRow;
  try {
    file = await fs.mustResolve(uri);
  } catch {
    return c.body(null, 404);
  }

  const responses: string[] = [];
  const isDir = isFolderRow(fs, file);
  responses.push(
    davResponseXml({
      href: hrefFor(uri, isDir),
      displayName: file.name || '/',
      isCollection: isDir,
      size: Number(file.size ?? 0),
      modifiedAt: file.updated_at ?? new Date(),
    }),
  );

  if (isDir && depth === 1) {
    const list = await fs.list(uri, {
      page: 0,
      pageSize: 100000,
      orderBy: 'name',
      orderDirection: 'asc',
    });
    for (const item of list.files) {
      const childUri = uri.child(item.name);
      const childIsDir = item.type === FileType.Folder;
      responses.push(
        davResponseXml({
          href: hrefFor(childUri, childIsDir),
          displayName: item.name,
          isCollection: childIsDir,
          size: Number(item.size ?? 0),
          modifiedAt: new Date(item.updated_at ?? Date.now()),
        }),
      );
    }
  }

  return c.body(multistatus(responses), 207, {
    'Content-Type': 'application/xml; charset=utf-8',
  });
});

davRoutes.on(['GET', 'HEAD'], '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  const fs = new FileSystemService(ctx);
  let file: FileRow;
  try {
    file = await fs.mustResolve(uri);
  } catch {
    return c.body(null, 404);
  }

  if (isFolderRow(fs, file)) {
    // 目录：返回简单 HTML 列表（浏览器直接打开时用）
    const list = await fs.list(uri, {
      page: 0,
      pageSize: 1000,
      orderBy: 'name',
      orderDirection: 'asc',
    });
    const html = `<!doctype html><meta charset="utf-8"><title>${escapeXml(file.name || '/')}</title><ul>${list.files
      .map((f) => `<li><a href="${escapeXml(uri.child(f.name).path)}">${escapeXml(f.name)}</a></li>`)
      .join('')}</ul>`;
    return c.html(html);
  }

  const content = await openEntityStream(ctx, file, c.req.header('Range') ?? null);
  if (!content) return c.body(null, 404);

  c.header('Content-Type', content.contentType ?? 'application/octet-stream');
  c.header('Accept-Ranges', 'bytes');
  c.header('Last-Modified', httpDate(file.updated_at ?? new Date()));

  if (content.contentRange && c.req.header('Range')) {
    // 上游存储按 206 语义应答（content-range 已带），这里同样回 206
    c.header('Content-Range', content.contentRange);
    if (c.req.method === 'HEAD') return c.body(null, 206);
    return c.body(content.body as ReadableStream, 206);
  }

  // HEAD 必须带实体长度，否则部分客户端（Explorer 映射、播放器）拿不到大小
  const length = Number(
    content.contentRange?.match(/\/(\d+)$/)?.[1] ?? content.size ?? file.size ?? 0,
  );
  if (Number.isFinite(length) && length > 0) c.header('Content-Length', String(length));
  if (c.req.method === 'HEAD') return c.body(null, 200);
  return c.body(content.body as ReadableStream, 200);
});

davRoutes.on('PUT', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);
  if (!uri.elements.length) return c.body(null, 405); // 不能写根目录

  const fs = new FileSystemService(ctx);
  const upload = new UploadService(ctx, fs);
  const length = Number(c.req.header('Content-Length') ?? 0);
  const body = c.req.raw.body;
  if (!body) return c.body(null, 400);

  const existing = await fs.resolve(uri);
  if (existing && existing.file_children !== null) {
    return c.body(null, 405); // 目标是目录
  }

  try {
    if (!existing) {
      // 先建文件行（父目录不存在会抛 CodeParentNotExist → 409）
      await fs.create(uri, 'file', { errOnConflict: true });
    }
    await upload.overwriteContent(
      uri,
      body,
      Number.isFinite(length) ? length : 0,
      c.req.header('Content-Type') ?? 'application/octet-stream',
      { ignoreMaxEdit: true },
    );
    return c.body(null, 201);
  } catch (e) {
    console.error('webdav put failed', e);
    return c.body(null, 500);
  }
});

davRoutes.on('MKCOL', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);
  if (!uri.elements.length) return c.body(null, 405);

  const fs = new FileSystemService(ctx);
  try {
    await fs.create(uri, 'folder', { errOnConflict: true });
    return c.body(null, 201);
  } catch (e) {
    if ((e as { code?: number }).code === CodeObjectExist) return c.body(null, 405);
    return c.body(null, 409); // 父目录不存在等
  }
});

davRoutes.on('DELETE', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri || !uri.elements.length) return c.body(null, 403); // 不能删根

  const fs = new FileSystemService(ctx);
  try {
    await fs.delete([uri], { skipSoftDelete: true });
    return c.body(null, 204);
  } catch {
    return c.body(null, 404);
  }
});

davRoutes.on(['COPY', 'MOVE'], '*', async (c) => {
  const ctx = ctxOf(c);
  const srcUri = targetUri(c);
  if (!srcUri || !srcUri.elements.length) return c.body(null, 403);

  const destHeader = c.req.header('Destination');
  if (!destHeader) return c.body(null, 400);
  // Destination 是绝对 URL 或绝对路径，取 pathname 部分
  let destPath: string;
  try {
    destPath = new URL(destHeader, c.req.url).pathname;
  } catch {
    return c.body(null, 400);
  }
  if (!destPath.startsWith(DAV_PREFIX)) return c.body(null, 502);

  const account = davAccountOf(c);
  const base = URI.tryParse(account.uri);
  if (!base || base.fsType !== 'my') return c.body(null, 403);
  const rel = decodeURIComponent(destPath.slice(DAV_PREFIX.length));
  const dstUri = base.withPath(
    (base.path.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '')).replace(/\/{2,}/g, '/'),
  );
  // 同样校验目标仍在账号根内，防止通过 Destination 头做路径穿越。
  if (base.path !== '/' && dstUri.path !== base.path && !dstUri.path.startsWith(base.path + '/')) {
    return c.body(null, 403);
  }

  const fs = new FileSystemService(ctx);
  const isCopy = c.req.method === 'COPY';
  const overwrite = (c.req.header('Overwrite') ?? 'T').toUpperCase() !== 'F';

  try {
    const src = await fs.mustResolve(srcUri);
    const dst = await fs.resolve(dstUri);

    // 目标语义（RFC 4918 + 上游 handleCopyMove）：
    //   dst 是目录  → 目标落在 dst/<src.name>
    //   dst 是文件  → Overwrite=T 先删，再落到 dst.parent()/src.name
    //   dst 不存在 → dst.parent() 是落点，最后一段是新名字
    let targetParent: URI;
    let targetName = srcUri.name;
    if (dst && isFolderRow(fs, dst)) {
      targetParent = dstUri;
    } else if (dst) {
      if (!overwrite) return c.body(null, 412);
      await fs.delete([dstUri], { skipSoftDelete: true });
      targetParent = dstUri.parent();
    } else {
      targetParent = dstUri.parent();
      targetName = dstUri.name;
    }

    // 父目录必须存在且是目录（否则 409）
    const parent = await fs.resolve(targetParent);
    if (!parent || !isFolderRow(fs, parent)) return c.body(null, 409);

    // 同目录改名/覆盖：moveOrCopy 的同名冲突检查会把**源自己**当冲突（源就
    // 落在该目录里），必须走 rename 直改；rename 自带同名冲突校验。
    if (!isCopy && targetParent.path === srcUri.parent().path) {
      await fs.rename(srcUri, targetName);
      return c.body(null, 201);
    }

    await fs.moveOrCopy([srcUri], targetParent, isCopy);

    // 落点名字与原名不同 → 搬/复制完改名
    if (targetName !== srcUri.name) {
      const childUri = targetParent.child(srcUri.name);
      await fs.rename(childUri, targetName);
    }
    return c.body(null, isCopy ? 204 : 201);
  } catch (e) {
    console.error('webdav copy/move failed', e);
    return c.body(null, 409);
  }
});

davRoutes.on('PROPPATCH', '*', async (c) => {
  // 属性修改（如修改时间）不支持但也不阻塞客户端 —— 逐属性标 403
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);
  const href = `${DAV_PREFIX}${uri.path}`;
  const xml =
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
    `<D:response><D:href>${escapeXml(href)}</D:href>` +
    `<D:propstat><D:prop/><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat>` +
    `</D:response></D:multistatus>`;
  return c.body(xml, 207, { 'Content-Type': 'application/xml; charset=utf-8' });
});

// ---------------------------------------------------------------------------
// 简化锁（KV）
// ---------------------------------------------------------------------------

function lockKey(token: string): string {
  return `dav_lock:${token}`;
}

davRoutes.on('LOCK', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  // Timeout: Second-3600
  const timeoutHeader = c.req.header('Timeout') ?? '';
  const m = timeoutHeader.match(/Second-(\d+)/);
  const ttl = Math.min(3600, m ? Number(m[1]) : LOCK_DEFAULT_TTL);

  const token = crypto.randomUUID();
  await kvFor(ctx.env, 'upload').put(
    lockKey(token),
    JSON.stringify({ path: uri.path, owner: ctx.user!.id, created: Date.now() }),
    { expirationTtl: Math.max(60, ttl) },
  );

  const xml =
    `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery>` +
    `<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
    `<D:depth>0</D:depth><D:owner>${escapeXml(ctx.user!.email ?? '')}</D:owner>` +
    `<D:timeout>Second-${ttl}</D:timeout>` +
    `<D:locktoken><D:href>opaquelocktoken:${token}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${escapeXml(`${DAV_PREFIX}${uri.path}`)}</D:href></D:lockroot>` +
    `</D:activelock></D:lockdiscovery></D:prop>`;
  return c.body(xml, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Lock-Token': `<opaquelocktoken:${token}>`,
  });
});

davRoutes.on('UNLOCK', '*', async (c) => {
  const ctx = ctxOf(c);
  const tokenHeader = c.req.header('Lock-Token') ?? '';
  const token = tokenHeader.replace(/[<>\s]/g, '').replace('opaquelocktoken:', '');
  if (token) {
    const raw = await kvFor(ctx.env, 'upload').get(lockKey(token));
    if (raw) {
      const info = JSON.parse(raw) as { path: string; owner: number };
      if (info.owner === ctx.user!.id) await kvFor(ctx.env, 'upload').delete(lockKey(token));
    }
  }
  return c.body(null, 204);
});
