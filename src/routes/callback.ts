/**
 * 上传回调路由。对应 Cloudreve v4 `routers/router.go:472-546` 的 callback 分组。
 *
 * 边缘版只实现 **OneDrive** 一条：它的上传是客户端直传微软，字节不经过 Worker，
 * 所以「实体转正 + 容量记账」必须由客户端打完最后一字节后回调这里触发
 * （原版同样如此，见 `service/callback/upload.go:44-60` 的 `ProcessCallback`）。
 *
 * 其余驱动（remote / oss / upyun / cos / s3 / ks3 / obs / qiniu）边缘版不实现，
 * 统一返回 `CodeFeatureNotEnabled`，避免前端拿到 404 后误判。
 *
 * 鉴权：URL 里的 `:key` 必须等于上传会话的 `callbackSecret`。原版在
 * `middleware/auth.go:194-219` 做常量时间比较，不匹配报 `CodeCredentialInvalid`；
 * 会话不存在或过期报 `CodeUploadSessionExpired`。这三条都在服务层实现。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { AppError, CodeFeatureNotEnabled } from '../lib/errors';
import { FileSystemService } from '../services/fs';
import { UploadService } from '../services/upload';

export const callbackRoutes = new Hono<AppBindings>();

/** OneDrive 直传完成回调。 */
callbackRoutes.post('/onedrive/:sessionID/:key', async (c) => {
  const ctx = ctxOf(c);
  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    await upload.completeByCallback(c.req.param('sessionID'), c.req.param('key'));
    return c.json(ok(c) as never);
  } catch (e) {
    return c.json(fail(c, e) as never);
  }
});

callbackRoutes.all('/*', (c) =>
  c.json(
    fail(
      c,
      new AppError(
        CodeFeatureNotEnabled,
        'Only the OneDrive upload callback is implemented in the edge build',
      ),
    ) as never,
  ),
);
