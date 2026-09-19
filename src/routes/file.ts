/**
 * 文件路由。对应 Cloudreve v4 `routers/router.go` 的 file 分组。
 *
 * 已实现的端点（路径与请求/响应字段对齐原版）：
 *   GET    /api/v4/file                      列目录 / 回收站 / 搜索
 *   GET    /api/v4/file/info                 单文件详情
 *   POST   /api/v4/file/create               新建文件夹/文件
 *   POST   /api/v4/file/rename               重命名
 *   POST   /api/v4/file/move                 移动 / 复制
 *   POST   /api/v4/file/url                  取下载/预览地址
 *   GET    /api/v4/file/thumb                缩略图地址
 *   GET    /api/v4/file/content/:id/:speed/:name   实体内容（代理下载，需签名）
 *   PUT    /api/v4/file/content              覆盖文件内容
 *   DELETE /api/v4/file                      删除（进回收站）
 *   POST   /api/v4/file/restore              从回收站恢复
 *   DELETE /api/v4/file/trash                清空回收站
 *   PATCH  /api/v4/file/metadata             修改元数据
 *   PATCH  /api/v4/file/view                 保存目录视图
 *   PUT    /api/v4/file/upload               创建上传会话
 *   POST   /api/v4/file/upload/:sid/:index   上传分片
 *   DELETE /api/v4/file/upload               取消上传
 *   PUT|DELETE /api/v4/file/pin              固定 / 取消固定
 *   PUT    /api/v4/file/source               创建直链
 *   DELETE /api/v4/file/source/:id           删除直链
 */
import { Hono } from 'hono';
import type { AppBindings, AppRequest } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { FileSystemService } from '../services/fs';
import { UploadService } from '../services/upload';
import { DownloadService } from '../services/download';
import { UserService } from '../services/user';
import { URI } from '../services/uri';
import { FileType } from '../lib/boolset';
import { AppError, CodeFeatureNotEnabled, Err } from '../lib/errors';

export const fileRoutes = new Hono<AppBindings>();

/** 统一的「需要登录」守卫 */
function guard(c: AppRequest): boolean {
  return Boolean(ctxOf(c).user);
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

fileRoutes.get('/', async (c) => {
  const ctx = ctxOf(c);

  const rawUri = c.req.query('uri');
  if (!rawUri) return c.json(fail(c, Err.param('uri is required')) as never);

  let uri: URI;
  try {
    uri = URI.parse(rawUri);
  } catch {
    return c.json(fail(c, Err.param('Invalid uri')) as never);
  }

  // 这里**不能**一刀切要求登录：匿名访问分享目录是合法路径（原版靠匿名用户组放行，
  // share navigator 自己会校验密码与 ShareDownload 权限）。
  // my / trash 的登录要求由 resolveMy / resolveTrash 内部抛 401。

  const page = Math.max(0, Number(c.req.query('page') ?? 0) || 0);
  const pageSize = Number(c.req.query('page_size') ?? 0) || 0;
  const orderBy = c.req.query('order_by') ?? '';
  const orderDirection = c.req.query('order_direction') ?? '';
  const typeRaw = c.req.query('type');

  let typeFilter: number | null = null;
  if (typeRaw === 'file') typeFilter = FileType.File;
  else if (typeRaw === 'folder') typeFilter = FileType.Folder;

  try {
    const service = new FileSystemService(ctx);
    const res = await service.list(uri, { page, pageSize, orderBy, orderDirection, typeFilter });
    return c.json(ok(c, res) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.get('/info', async (c) => {
  const ctx = ctxOf(c);

  const rawUri = c.req.query('uri');
  const idHash = c.req.query('id');
  const extended = c.req.query('extended') === 'true';
  const wantSummary = c.req.query('folder_summary') === 'true';

  const service = new FileSystemService(ctx);
  try {
    let file;
    if (rawUri) {
      // 走 navigator：分享要过密码与权限，my 要求是本人
      file = await service.mustResolve(URI.parse(rawUri));
    } else if (idHash) {
      const id = ctx.codec.decodeFileID(idHash);
      if (id === null) throw Err.fileNotFound();
      const target = await ctx.files.byId(id);
      if (!target) throw Err.fileNotFound();
      // 与原版 `GetFileInfoService.Get` 一致：id 先还原成 URI（`m.TraverseFile`），
      // 再交给 navigator 做权限校验 —— 否则就是凭 hashid 越权读元数据。
      const backUri = service.isInTrash(target)
        ? URI.trash(target.name)
        : URI.my(await service.pathOf(target));
      file = await service.mustResolve(backUri);
    } else {
      return c.json(fail(c, Err.param('uri or id is required')) as never);
    }
    return c.json(
      ok(c, await service.buildFileResponse(file, { extended, folderSummary: wantSummary })) as never,
    );
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

// ---------------------------------------------------------------------------
// 创建 / 重命名 / 移动
// ---------------------------------------------------------------------------

fileRoutes.post('/create', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as {
    uri?: string;
    type?: string;
    metadata?: Record<string, string>;
    err_on_conflict?: boolean;
  };
  if (!body.uri || !body.type) return c.json(fail(c, Err.param('uri and type are required')) as never);
  if (body.type !== 'file' && body.type !== 'folder') {
    return c.json(fail(c, Err.param('type must be "file" or "folder"')) as never);
  }
  try {
    const res = await new FileSystemService(ctx).create(URI.parse(body.uri), body.type, {
      metadata: body.metadata,
      errOnConflict: body.err_on_conflict,
    });
    return c.json(ok(c, res) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.post('/rename', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as { uri?: string; new_name?: string };
  if (!body.uri || !body.new_name) {
    return c.json(fail(c, Err.param('uri and new_name are required')) as never);
  }
  try {
    const res = await new FileSystemService(ctx).rename(URI.parse(body.uri), body.new_name);
    return c.json(ok(c, res) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.post('/move', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as {
    uris?: string[];
    dst?: string;
    copy?: boolean;
  };
  if (!body.uris?.length || !body.dst) {
    return c.json(fail(c, Err.param('uris and dst are required')) as never);
  }
  if (body.uris.length > ctx.settings.maxBatchedFile) {
    return c.json(fail(c, new AppError(40074, 'Too many uris')) as never);
  }
  try {
    const service = new FileSystemService(ctx);
    await service.moveOrCopy(
      body.uris.map((u) => URI.parse(u)),
      URI.parse(body.dst),
      body.copy === true,
    );
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

// ---------------------------------------------------------------------------
// 下载地址
// ---------------------------------------------------------------------------

fileRoutes.post('/url', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    uris?: string[];
    download?: boolean;
    redirect?: boolean;
    entity?: string;
    no_cache?: boolean;
  };
  if (!body.uris?.length) return c.json(fail(c, Err.param('uris is required')) as never);

  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    const res = await download.getUrls(
      body.uris.map((u) => URI.parse(u)),
      { download: body.download, entity: body.entity, noCache: body.no_cache },
    );

    // 单个 uri 且要求 redirect 时直接 302（原版行为）
    if (body.redirect && body.uris.length === 1 && res.urls[0]) {
      return c.redirect(res.urls[0].url, 302);
    }
    return c.json(ok(c, res) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.get('/thumb', async (c) => {
  const ctx = ctxOf(c);
  const rawUri = c.req.query('uri');
  if (!rawUri) return c.json(fail(c, Err.param('uri is required')) as never);
  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    return c.json(ok(c, await download.thumb(URI.parse(rawUri))) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

/**
 * 实体内容分发（代理下载）。
 * 需要 URL 签名；支持 Range，便于视频拖动。
 */
const serveContent = async (c: AppRequest) => {
  const ctx = ctxOf(c);
  const entityHash = c.req.param('id') ?? '';
  const name = c.req.param('name') ?? '';

  // 校验签名：路径参与签名，query 里的 sign 本身不参与
  const url = new URL(c.req.url);
  const sign = url.searchParams.get('sign');
  if (!sign) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer Cr ')) {
      return c.json(fail(c, new AppError(403, 'authorization header is missing')) as never);
    }
    try {
      await ctx.signer.check(url.pathname, authHeader.slice('Bearer Cr '.length));
    } catch (e) {
      return c.json(fail(c, e) as never);
    }
  } else {
    try {
      await ctx.signer.check(url.pathname, sign);
    } catch (e) {
      return c.json(fail(c, e) as never);
    }
  }

  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    const content = await download.serveEntity(entityHash, name, c.req.header('Range') ?? null);

    const headers = new Headers();
    headers.set('Content-Type', content.contentType ?? 'application/octet-stream');
    headers.set('Accept-Ranges', 'bytes');
    if (content.contentRange) {
      headers.set('Content-Range', content.contentRange);
      headers.set('Content-Length', String(content.size));
    } else {
      headers.set('Content-Length', String(content.size));
    }
    // 与原版一致：内容接口允许跨域
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition');

    if (c.req.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(content.body, {
      status: content.contentRange ? 206 : 200,
      headers,
    });
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
};

fileRoutes.get('/content/:id/:speed/:name', serveContent);
fileRoutes.on('HEAD', '/content/:id/:speed/:name', serveContent);

/** CORS 预检 */
fileRoutes.options('/content/*', (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
});

/** 覆盖文件内容（PUT 原始字节流） */
fileRoutes.put('/content', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const rawUri = c.req.query('uri');
  if (!rawUri) return c.json(fail(c, Err.param('uri is required')) as never);

  const body = c.req.raw.body;
  if (!body) return c.json(fail(c, Err.param('Request body is required')) as never);

  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    await upload.overwriteContent(
      URI.parse(rawUri),
      body,
      Number(c.req.header('Content-Length') ?? 0),
      c.req.header('Content-Type') ?? '',
    );
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

// ---------------------------------------------------------------------------
// 删除 / 恢复 / 清空
// ---------------------------------------------------------------------------

fileRoutes.delete('/', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as {
    uris?: string[];
    unlink?: boolean;
    skip_soft_delete?: boolean;
  };
  if (!body.uris?.length) return c.json(fail(c, Err.param('uris is required')) as never);
  if (body.uris.length > ctx.settings.maxBatchedFile) {
    return c.json(fail(c, new AppError(40074, 'Too many uris')) as never);
  }
  try {
    await new FileSystemService(ctx).delete(
      body.uris.map((u) => URI.parse(u)),
      { unlinkOnly: body.unlink, skipSoftDelete: body.skip_soft_delete },
    );
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.post('/restore', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as { uris?: string[] };
  if (!body.uris?.length) return c.json(fail(c, Err.param('uris is required')) as never);
  try {
    await new FileSystemService(ctx).restore(body.uris.map((u) => URI.parse(u)));
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.delete('/trash', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  try {
    await new FileSystemService(ctx).emptyTrash();
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

/** 强制解锁（边缘版没有文件锁，直接成功） */
fileRoutes.delete('/lock', async (c) => c.json(ok(c) as never));

// ---------------------------------------------------------------------------
// 元数据与视图
// ---------------------------------------------------------------------------

fileRoutes.patch('/metadata', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as {
    uris?: string[];
    patches?: { key: string; value?: string; private?: boolean; remove?: boolean }[];
  };
  if (!body.uris?.length || !body.patches?.length) {
    return c.json(fail(c, Err.param('uris and patches are required')) as never);
  }
  try {
    const service = new FileSystemService(ctx);
    for (const raw of body.uris) {
      const file = await service.mustResolve(URI.parse(raw));
      for (const patch of body.patches) {
        if (patch.remove) {
          await ctx.metadata.remove(file.id, patch.key);
        } else {
          // 原版要求元数据必须是 public（private=true 会被 binding 拒绝）
          await ctx.metadata.upsert(file.id, patch.key, patch.value ?? '', !patch.private);
        }
      }
    }
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.patch('/view', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as {
    uri?: string;
    view?: Record<string, unknown>;
  };
  if (!body.uri) return c.json(fail(c, Err.param('uri is required')) as never);
  try {
    const service = new FileSystemService(ctx);
    const file = await service.mustResolve(URI.parse(body.uri));
    const props = { ...(file.props ?? {}) };
    if (body.view) props.view = body.view as never;
    await ctx.files.patchProps(file.id, props as Record<string, unknown>);
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

fileRoutes.put('/upload', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as {
    uri?: string;
    size?: number;
    last_modified?: number;
    mime_type?: string;
    policy_id?: string;
    metadata?: Record<string, string>;
    entity_type?: string;
  };
  if (!body.uri) return c.json(fail(c, Err.param('uri is required')) as never);

  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    const res = await upload.createSession({
      uri: body.uri,
      size: Number(body.size ?? 0),
      lastModified: body.last_modified,
      mimeType: body.mime_type,
      policyId: body.policy_id,
      metadata: body.metadata,
      entityType: body.entity_type,
    });
    return c.json(ok(c, res) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.post('/upload/:sessionId/:index', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);

  const sessionId = c.req.param('sessionId');
  const index = Number(c.req.param('index'));
  const contentLength = Number(c.req.header('Content-Length') ?? 0);

  if (!Number.isInteger(index) || index < 0) {
    return c.json(fail(c, new AppError(40012, 'Invalid chunk index')) as never);
  }
  const body = c.req.raw.body;
  if (!body) return c.json(fail(c, Err.param('Request body is required')) as never);

  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    await upload.uploadChunk(sessionId, index, body, contentLength);
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.delete('/upload', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; uri?: string };
  if (!body.id) return c.json(fail(c, Err.param('id is required')) as never);
  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    await upload.deleteSession(body.id, body.uri);
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

// ---------------------------------------------------------------------------
// 固定
// ---------------------------------------------------------------------------

fileRoutes.put('/pin', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as { uri?: string; name?: string };
  if (!body.uri) return c.json(fail(c, Err.param('uri is required')) as never);
  try {
    await new UserService(ctx).pin(body.uri, body.name, true);
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.delete('/pin', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as { uri?: string };
  if (!body.uri) return c.json(fail(c, Err.param('uri is required')) as never);
  try {
    await new UserService(ctx).pin(body.uri, undefined, false);
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

// ---------------------------------------------------------------------------
// 直链
// ---------------------------------------------------------------------------

fileRoutes.put('/source', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  const body = (await c.req.json().catch(() => ({}))) as { uris?: string[] };
  if (!body.uris?.length) return c.json(fail(c, Err.param('uris is required')) as never);
  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    const links = await download.createDirectLink(URI.parse(body.uris[0]!));
    return c.json(ok(c, { link: links[0]?.url ?? '' }) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

fileRoutes.delete('/source/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return c.json(fail(c, Err.loginRequired()) as never);
  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    await download.deleteDirectLink(c.req.param('id'));
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

// ---------------------------------------------------------------------------
// 未实现的端点：明确返回「未启用」，避免前端拿到 404 后误判
// ---------------------------------------------------------------------------

const NOT_IMPLEMENTED: Record<string, string> = {
  '/archive': 'Archive listing is not implemented in the edge build',
  '/events': 'Server-sent events are not implemented in the edge build',
  '/search': 'Full text search is not implemented in the edge build',
  '/wopi': 'WOPI is not implemented in the edge build',
  '/viewerSession': 'Viewer sessions are not implemented in the edge build',
  '/version/current': 'File version switching is not implemented in the edge build',
  '/version': 'File version management is not implemented in the edge build',
};

fileRoutes.all('/archive/:sessionID/archive.zip', (c) =>
  c.json(fail(c, new AppError(CodeFeatureNotEnabled, 'Archive download is not implemented')) as never),
);

for (const [path, message] of Object.entries(NOT_IMPLEMENTED)) {
  fileRoutes.all(path, (c) => c.json(fail(c, new AppError(CodeFeatureNotEnabled, message)) as never));
}

export { guard };
