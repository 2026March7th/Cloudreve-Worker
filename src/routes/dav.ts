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
 *   - LOCK 实现了 RFC 4918 的写锁：exclusive / shared、Depth 0 / infinity、
 *     Timeout 续期、UNLOCK，并在 PUT / MKCOL / DELETE / COPY / MOVE / PROPPATCH
 *     上校验 If 头里的 lock token（缺 token → 423 Locked）。
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

/** PROPFIND 单目录最多枚举的子项数，超出则截断（防超大目录把响应体撑爆 Worker 内存）。 */
const PROPFIND_MAX = 5000;

/** LOCK 能力声明（RFC 4918 §15.10）：exclusive 与 shared 都支持。 */
const SUPPORTED_LOCK_XML =
  '<D:supportedlock>' +
  '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '</D:supportedlock>';

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
  /** 已序列化的 <D:lockdiscovery>（RFC 4918 §15.8），没有活动锁时给空元素。 */
  lockDiscovery?: string;
}): string {
  // getetag：Windows 的 WebClient(MRxDAV) 依赖它做资源身份/缓存判定，缺失会导致
  // 文件打不开、列表显示陈旧内容，甚至挂载后无法进入目录。
  const etag = `"${args.size}-${Math.floor(args.modifiedAt.getTime() / 1000)}"`;
  const props = [
    `<D:displayname>${escapeXml(args.displayName)}</D:displayname>`,
    `<D:getlastmodified>${httpDate(args.modifiedAt)}</D:getlastmodified>`,
    `<D:getetag>${etag}</D:getetag>`,
    args.isCollection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    args.isCollection ? '' : `<D:getcontentlength>${args.size}</D:getcontentlength>`,
    args.isCollection
      ? ''
      : `<D:getcontenttype>${escapeXml(args.contentType ?? 'application/octet-stream')}</D:getcontenttype>`,
    `<D:creationdate>${args.modifiedAt.toISOString()}</D:creationdate>`,
    SUPPORTED_LOCK_XML,
    args.lockDiscovery ?? '<D:lockdiscovery/>',
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
  // 集合资源（目录）的 href 必须以 / 结尾。Windows 的 WebClient 会拿响应里的
  // <D:href> 与请求 URL 逐字节比对，若不一致（比如请求 /dav/ 却回 /dav）就报
  // “找不到网络路径”，导致映射网络驱动器直接失败。根目录同样给 /dav/ 而非 /dav。
  const withSlash = isDir && !encoded.endsWith('/') ? `${encoded}/` : encoded;
  const full = `${DAV_PREFIX}${withSlash}`;
  return full === DAV_PREFIX ? `${DAV_PREFIX}/` : full;
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

  // 活动锁一次性取出（锁数量很少），每个资源按「覆盖关系」挂自己的 lockdiscovery：
  // 上级目录的 Depth:infinity 锁也会出现在子项的 lockdiscovery 里（RFC 4918 §6.1）。
  const kv = kvFor(ctx.env, 'upload');
  const activeLocks = await loadLocks(kv);
  const recordCache = new Map<string, DavLock>();
  const lockDiscoveryFor = async (path: string): Promise<string> => {
    const covering = activeLocks.filter((l) => lockCovers(l.path, l.depth, path));
    if (covering.length === 0) return '<D:lockdiscovery/>';
    const records: DavLock[] = [];
    for (const l of covering) {
      let record = recordCache.get(l.token);
      if (!record) {
        const raw = await kv.get(lockKey(l.token));
        if (!raw) continue;
        record = JSON.parse(raw) as DavLock;
        recordCache.set(l.token, record);
      }
      records.push(record);
    }
    return lockDiscoveryXml(records);
  };

  responses.push(
    davResponseXml({
      href: hrefFor(uri, isDir),
      displayName: file.name || '/',
      isCollection: isDir,
      size: Number(file.size ?? 0),
      modifiedAt: file.updated_at ?? new Date(),
      lockDiscovery: await lockDiscoveryFor(decodedPath(uri)),
    }),
  );

  if (isDir && depth === 1) {
    const list = await fs.list(uri, {
      page: 0,
      pageSize: PROPFIND_MAX,
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
          lockDiscovery: await lockDiscoveryFor(decodedPath(childUri)),
        }),
      );
    }
  }

  const xml = multistatus(responses);
  // Windows WebClient 拒绝分块（Transfer-Encoding: chunked）的 WebDAV 响应，
  // 必须带显式 Content-Length；Workers 对字符串体通常会自动算，这里再显式保底。
  return c.body(xml, 207, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': String(new TextEncoder().encode(xml).length),
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
  c.header('ETag', `"${Number(file.size ?? 0)}-${Math.floor((file.updated_at ?? new Date()).getTime() / 1000)}"`);

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

  const blocked = await lockedWriteResponse(c, [uri]);
  if (blocked) return blocked;

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
  const blocked = await lockedWriteResponse(c, [uri]);
  if (blocked) return blocked;
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
  // 删目录时，树内子孙上的锁同样要求携带 token（RFC 4918 §7.5）
  const blocked = await lockedWriteResponse(c, [uri], { includeDescendants: true });
  if (blocked) return blocked;
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
  // Overwrite 只接受 T / F（缺省 T）。其他值按上游 parseOverwrite 回 400，
  // 不能默默当成 T —— 否则客户端写错头会被当成「允许覆盖」，直接毁掉目标文件。
  const overwriteHeader = (c.req.header('Overwrite') ?? 'T').toUpperCase();
  if (overwriteHeader !== 'T' && overwriteHeader !== 'F') return c.body(null, 400);
  const overwrite = overwriteHeader === 'T';

  // MOVE 会改动源，COPY 只读源；目标两者都要写 —— 两侧都过锁校验
  const blocked = await lockedWriteResponse(
    c,
    isCopy ? [dstUri] : [srcUri, dstUri],
    { includeDescendants: !isCopy },
  );
  if (blocked) return blocked;

  try {
    const src = await fs.mustResolve(srcUri);
    const dst = await fs.resolve(dstUri);
    // 目标是否已存在：决定成功时的状态码（已存在 → 204 No Content，新建 → 201
    // Created），与上游 performCopyMove 一致。
    const dstExists = dst !== null;

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
      // 锁跟着资源走（RFC 4918 §7.5）
      await moveLockRoots(c, decodedPath(srcUri), decodedPath(targetParent.child(targetName)));
      return c.body(null, dstExists ? 204 : 201);
    }

    await fs.moveOrCopy([srcUri], targetParent, isCopy);

    // 落点名字与原名不同 → 搬/复制完改名
    if (targetName !== srcUri.name) {
      const childUri = targetParent.child(srcUri.name);
      await fs.rename(childUri, targetName);
    }
    if (!isCopy) {
      await moveLockRoots(c, decodedPath(srcUri), decodedPath(targetParent.child(targetName)));
    }
    return c.body(null, dstExists ? 204 : 201);
  } catch (e) {
    console.error('webdav copy/move failed', e);
    return c.body(null, 409);
  }
});

davRoutes.on('PROPPATCH', '*', async (c) => {
  // 属性修改（如修改时间）不支持但也不阻塞客户端 —— 逐属性标 403。
  // 但被锁的资源仍要先按 RFC 4918 §9.2 校验 token（否则 423）。
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);
  const blocked = await lockedWriteResponse(c, [uri]);
  if (blocked) return blocked;
  const href = `${DAV_PREFIX}${uri.path}`;
  const xml =
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
    `<D:response><D:href>${escapeXml(href)}</D:href>` +
    `<D:propstat><D:prop/><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat>` +
    `</D:response></D:multistatus>`;
  return c.body(xml, 207, { 'Content-Type': 'application/xml; charset=utf-8' });
});

// ---------------------------------------------------------------------------
// RFC 4918 写锁（exclusive / shared，Depth 0 / infinity）
// ---------------------------------------------------------------------------
//
// 存储用 upload 角色的 KV：
//   dav_lock:<token> → DavLock(JSON)，带 expirationTtl，过期自动回收；
//   同时在 KV metadata 里放「覆盖判定」需要的字段 —— 一次 list 就能判断
//   某路径有没有被锁，不必为每个候选锁再 get 一次。
//
// 一致性取舍：KV list 是最终一致的（同一 colo 内基本即时）。WebDAV 客户端
// 都是 LOCK 成功之后才写，同 colo 命中，实测可用；要强一致得把锁表搬进主库，
// 每次写多一次跨区往返 —— 这里选延迟。

const LOCK_MAX_TTL = 7 * 24 * 3600; // 7 天；Timeout: Infinite 也按它封顶
const LOCK_KEY_PREFIX = 'dav_lock:';

type LockScope = 'exclusive' | 'shared';
type LockDepth = '0' | 'infinity';

interface DavLock {
  token: string;
  /** 锁根：逐段已解码的账号内路径（如 `/docs/a b.txt`） */
  path: string;
  isDir: boolean;
  depth: LockDepth;
  scope: LockScope;
  /** <D:owner> 的内部内容（已是可回写的 XML） */
  owner: string;
  /** 属主用户 id：只有本人能续期 / 解锁 */
  principal: number;
  createdAt: number;
  expiresAt: number;
}

/** KV metadata：覆盖判定只需要这些字段。 */
interface DavLockMeta {
  path: string;
  depth: LockDepth;
  scope: LockScope;
  principal: number;
  expiresAt: number;
}

function lockKey(token: string): string {
  return `${LOCK_KEY_PREFIX}${token}`;
}

/** 逐段解码的规范路径：URI.path 可能是编码过的（child() 会编码），锁比较统一用它。 */
function decodedPath(uri: URI): string {
  return uri.elements.length === 0 ? '/' : `/${uri.elements.join('/')}`;
}

/** href：逐段编码，目录补尾斜杠（与 hrefFor 保持一致）。 */
function pathHref(path: string, isDir = false): string {
  const encoded = path
    .split('/')
    .map((seg) => (seg === '' ? '' : encodeURIComponent(seg)))
    .join('/');
  const withSlash = isDir && !encoded.endsWith('/') ? `${encoded}/` : encoded;
  const full = `${DAV_PREFIX}${withSlash}`;
  return full === DAV_PREFIX ? `${DAV_PREFIX}/` : full;
}

/** `Timeout: Second-3600, Infinite` → 秒数。缺省 10 分钟，封顶 7 天。 */
function parseTimeout(header: string | undefined): number {
  const m = /Second-(\d+)/i.exec(header ?? '');
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return Math.min(n, LOCK_MAX_TTL);
  }
  if (/Infinite/i.test(header ?? '')) return LOCK_MAX_TTL;
  return LOCK_DEFAULT_TTL;
}

/** 解析 <D:lockinfo>；没有 lockinfo 说明是「续期」请求（RFC 4918 §9.10.2）。 */
function parseLockInfo(xml: string): { scope: LockScope; owner: string } | null {
  if (!/<(?:\w+:)?lockinfo\b/i.test(xml)) return null;
  const scope: LockScope = /<(?:\w+:)?shared\b[^>]*>/i.test(xml) ? 'shared' : 'exclusive';
  const owner = /<(?:\w+:)?owner\b[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/i.exec(xml);
  const rawOwner = owner ? owner[1]!.trim() : '';
  // owner 内部本身是 XML（通常是 <D:href>）就原样回写；纯文本转义后当文本节点
  return { scope, owner: rawOwner.includes('<') ? rawOwner : escapeXml(rawOwner) };
}

function parseLockToken(header: string | undefined): string | null {
  const m = /opaquelocktoken:([^>\s,]+)/i.exec(header ?? '');
  return m ? m[1]! : null;
}

interface IfCondition {
  not: boolean;
  token?: string;
  etag?: string;
}

interface IfList {
  /** Resource-Tag（可缺省） */
  tag?: string;
  conditions: IfCondition[];
}

/**
 * 解析 If 头（RFC 4918 §10.4）。只关心状态令牌；ETag 条件保留但暂不求值。
 * 顶层 `<...>` 一律视为 Resource-Tag —— 状态令牌只会出现在括号列表内部。
 */
function parseIfHeader(raw: string | undefined): IfList[] {
  if (!raw) return [];
  const lists: IfList[] = [];
  let tag: string | undefined;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '(') {
      const end = raw.indexOf(')', i);
      if (end < 0) break;
      const inner = raw.slice(i + 1, end);
      const conditions: IfCondition[] = [];
      const re = /(Not\s+)?(?:<([^>]*)>|\[([^\]]*)\])/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(inner))) {
        const not = Boolean(m[1]);
        if (m[2] !== undefined) {
          const token = parseLockToken(m[2]);
          if (token) conditions.push({ not, token });
        } else if (m[3] !== undefined) {
          conditions.push({ not, etag: m[3].trim() });
        }
      }
      lists.push({ tag, conditions });
      tag = undefined;
      i = end + 1;
      continue;
    }
    if (ch === '<') {
      const end = raw.indexOf('>', i);
      if (end < 0) break;
      tag = raw.slice(i + 1, end).trim();
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return lists;
}

/** If 头里是否有「肯定断言」该 token（被 Not 否定的不算）。 */
function ifAssertsToken(lists: IfList[], token: string): boolean {
  for (const list of lists) {
    if (list.conditions.some((cond) => cond.not && cond.token === token)) continue;
    if (list.conditions.some((cond) => !cond.not && cond.token === token)) return true;
  }
  return false;
}

/** 读全部活动锁（只读 metadata，不取值）。 */
async function loadLocks(kv: KVNamespace): Promise<Array<DavLockMeta & { token: string }>> {
  const now = Date.now();
  const out: Array<DavLockMeta & { token: string }> = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await kv.list({ prefix: LOCK_KEY_PREFIX, cursor });
    for (const key of page.keys) {
      const meta = key.metadata as DavLockMeta | null;
      if (!meta || typeof meta.path !== 'string') continue;
      if (typeof meta.expiresAt === 'number' && meta.expiresAt <= now) continue;
      out.push({ token: key.name.slice(LOCK_KEY_PREFIX.length), ...meta });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

/** 锁是否覆盖某个路径：同路径，或 Depth:infinity 且目标在其子树内。 */
function lockCovers(lockPath: string, depth: LockDepth, targetPath: string): boolean {
  if (lockPath === targetPath) return true;
  if (depth !== 'infinity') return false;
  const prefix = lockPath === '/' ? '/' : `${lockPath}/`;
  return targetPath.startsWith(prefix);
}

async function putLock(kv: KVNamespace, lock: DavLock, ttlSeconds: number): Promise<void> {
  const metadata: DavLockMeta = {
    path: lock.path,
    depth: lock.depth,
    scope: lock.scope,
    principal: lock.principal,
    expiresAt: lock.expiresAt,
  };
  await kv.put(lockKey(lock.token), JSON.stringify(lock), {
    expirationTtl: Math.max(60, Math.min(ttlSeconds, LOCK_MAX_TTL)),
    metadata,
  });
}

/** 单个 <D:activelock>（RFC 4918 §14.11）。 */
function activelockXml(lock: DavLock): string {
  const remaining = Math.max(0, Math.round((lock.expiresAt - Date.now()) / 1000));
  return (
    '<D:activelock>' +
    '<D:locktype><D:write/></D:locktype>' +
    `<D:lockscope><D:${lock.scope}/></D:lockscope>` +
    `<D:depth>${lock.depth === 'infinity' ? 'infinity' : '0'}</D:depth>` +
    (lock.owner ? `<D:owner>${lock.owner}</D:owner>` : '') +
    `<D:timeout>Second-${remaining}</D:timeout>` +
    `<D:locktoken><D:href>opaquelocktoken:${lock.token}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${escapeXml(pathHref(lock.path, lock.isDir))}</D:href></D:lockroot>` +
    '</D:activelock>'
  );
}

function lockDiscoveryXml(locks: DavLock[]): string {
  if (locks.length === 0) return '<D:lockdiscovery/>';
  return `<D:lockdiscovery>${locks.map(activelockXml).join('')}</D:lockdiscovery>`;
}

function lockResponse(c: AppRequest, lock: DavLock, status: 200 | 201): Response {
  const xml =
    '<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:">' +
    lockDiscoveryXml([lock]) +
    '</D:prop>';
  const remaining = Math.max(0, Math.round((lock.expiresAt - Date.now()) / 1000));
  return c.body(xml, status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Lock-Token': `<opaquelocktoken:${lock.token}>`,
    Timeout: `Second-${remaining}`,
    'Content-Length': String(new TextEncoder().encode(xml).length),
  });
}

/**
 * 写前的锁校验（RFC 4918 §7.2 / §9.10.1）：
 *   - 目标被锁且请求没在 If 头里给出对应 token → 423 Locked；
 *   - `includeDescendants`（DELETE / MOVE）时，树内子孙上的锁同样要求 token。
 *
 * 严格按 RFC：不做「属主放行」—— 锁要防的正是同一个人的两个客户端并发写，
 * 放行等于把锁的意义抹掉。Windows / RaiDrive / Cyberduck 在写完 LOCK 之后
 * 都会在 If 头里带 token；rclone 这类根本不发 LOCK 的客户端不会触发校验。
 */
async function lockedWriteResponse(
  c: AppRequest,
  targets: URI[],
  opts: { includeDescendants?: boolean } = {},
): Promise<Response | null> {
  const ctx = ctxOf(c);
  const kv = kvFor(ctx.env, 'upload');
  const locks = await loadLocks(kv);
  if (locks.length === 0) return null;

  const lists = parseIfHeader(c.req.header('If'));

  for (const target of targets) {
    const path = decodedPath(target);
    const prefix = path === '/' ? '/' : `${path}/`;
    const related = locks.filter(
      (lock) =>
        lockCovers(lock.path, lock.depth, path) ||
        (opts.includeDescendants === true && lock.path.startsWith(prefix)),
    );
    for (const lock of related) {
      if (ifAssertsToken(lists, lock.token)) continue;
      return c.body(null, 423);
    }
  }
  return null;
}

/** MOVE 成功后把源树上的锁根一起挪过去（RFC 4918 §7.5）。 */
async function moveLockRoots(c: AppRequest, fromPath: string, toPath: string): Promise<void> {
  if (fromPath === toPath) return;
  const ctx = ctxOf(c);
  const kv = kvFor(ctx.env, 'upload');
  const locks = await loadLocks(kv);
  const prefix = fromPath === '/' ? '/' : `${fromPath}/`;
  for (const lock of locks) {
    if (lock.path !== fromPath && !lock.path.startsWith(prefix)) continue;
    const raw = await kv.get(lockKey(lock.token));
    if (!raw) continue;
    const record = JSON.parse(raw) as DavLock;
    record.path = `${toPath}${record.path.slice(fromPath.length)}`;
    const remaining = Math.max(60, Math.round((record.expiresAt - Date.now()) / 1000));
    await putLock(kv, record, remaining);
  }
}

davRoutes.on('LOCK', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  const kv = kvFor(ctx.env, 'upload');
  const fs = new FileSystemService(ctx);
  const ttl = parseTimeout(c.req.header('Timeout'));
  const bodyText = await c.req.text();
  const info = parseLockInfo(bodyText);

  // —— 续期：无实体，token 在 If 头里 ——
  if (!info) {
    const lists = parseIfHeader(c.req.header('If'));
    const tokens = new Set<string>();
    for (const list of lists) {
      for (const cond of list.conditions) if (!cond.not && cond.token) tokens.add(cond.token);
    }
    const hit = (await loadLocks(kv)).find(
      (lock) => tokens.has(lock.token) && lockCovers(lock.path, lock.depth, decodedPath(uri)),
    );
    if (!hit) return c.body(null, 412);
    if (hit.principal !== ctx.user!.id) return c.body(null, 403);
    const raw = await kv.get(lockKey(hit.token));
    if (!raw) return c.body(null, 412);
    const lock = JSON.parse(raw) as DavLock;
    lock.expiresAt = Date.now() + ttl * 1000;
    await putLock(kv, lock, ttl);
    return lockResponse(c, lock, 200);
  }

  // —— 新建锁 ——
  const depth: LockDepth = (c.req.header('Depth') ?? 'infinity').trim() === '0' ? '0' : 'infinity';

  let file = await fs.resolve(uri);
  let created = false;
  if (!file) {
    // RFC 4918 §7.3：锁一个还不存在的 URL → 先建一个空资源
    try {
      await fs.create(uri, 'file', { errOnConflict: true });
      file = await fs.mustResolve(uri);
      created = true;
    } catch {
      return c.body(null, 409);
    }
  }
  const isDir = isFolderRow(fs, file);

  const path = decodedPath(uri);
  const existingLocks = await loadLocks(kv);
  const overlap = existingLocks.filter(
    (lock) => lockCovers(lock.path, lock.depth, path) || lockCovers(path, depth, lock.path),
  );
  // exclusive 与任何锁冲突；shared 只在撞上 exclusive 时冲突（RFC 4918 §6.1）
  if (overlap.some((lock) => lock.scope === 'exclusive' || info.scope === 'exclusive')) {
    return c.body(null, 423);
  }

  const now = Date.now();
  const lock: DavLock = {
    token: crypto.randomUUID(),
    path,
    isDir,
    depth,
    scope: info.scope,
    owner: info.owner,
    principal: ctx.user!.id,
    createdAt: now,
    expiresAt: now + ttl * 1000,
  };
  await putLock(kv, lock, ttl);
  return lockResponse(c, lock, created ? 201 : 200);
});

davRoutes.on('UNLOCK', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  const kv = kvFor(ctx.env, 'upload');
  const token = parseLockToken(c.req.header('Lock-Token'));
  if (!token) return c.body(null, 409);
  const raw = await kv.get(lockKey(token));
  if (!raw) return c.body(null, 409);
  const lock = JSON.parse(raw) as DavLock;
  // Lock-Token 必须指向覆盖该资源的锁（RFC 4918 §9.11）
  if (!lockCovers(lock.path, lock.depth, decodedPath(uri))) return c.body(null, 409);
  if (lock.principal !== ctx.user!.id) return c.body(null, 403);
  await kv.delete(lockKey(token));
  return c.body(null, 204);
});
