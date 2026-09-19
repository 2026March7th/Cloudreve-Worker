/**
 * 统一响应封装。对应 Cloudreve v4 的 `pkg/serializer/response.go`。
 *
 * 关键行为（已回源码核对 `routers/controllers/main.go`）：
 *   - 业务错误一律以 **HTTP 200** 返回，错误信息放在正文的 `code` 字段里。
 *     只有 302 重定向、SSE 与文件流不走这个信封。
 *   - `msg` 字段始终存在（成功时为空串）。
 *   - `data` / `error` / `aggregated_error` / `correlation_id` 按 omitempty 省略。
 */
import type { Context } from 'hono';
import { AppError, CodeDBError, CodeNotSet, CodeParamErr } from './errors';

export interface Envelope<T = unknown> {
  code: number;
  data?: T;
  aggregated_error?: unknown;
  msg: string;
  error?: string;
  correlation_id?: string;
}

/** 成功响应：`{ code: 0, data, msg: "" }` */
export function ok<T>(c: Context, data?: T): Response {
  const body: Envelope<T> = { code: 0, msg: '' };
  if (data !== undefined) {
    body.data = data;
  }
  return jsonResponse(c, body);
}

/**
 * 显式带 code 的成功/部分成功响应（原版用 203 CodeNotFullySuccess 表示
 * 「注册成功但需要邮件激活」这类语义）。
 */
export function okWithCode<T>(c: Context, code: number, data?: T): Response {
  const body: Envelope<T> = { code, msg: '' };
  if (data !== undefined) {
    body.data = data;
  }
  return jsonResponse(c, body);
}

/**
 * 错误响应。镜像原版 `serializer.ErrWithDetails`：
 *   - 底层是 AppError 时，取其 code 与 msg；
 *   - 非生产模式下附加 `error` 明细。
 */
export function fail(c: Context, err: unknown): Response {
  let code = CodeNotSet;
  let msg = '';
  let raw: unknown = err;

  if (err instanceof AppError) {
    code = err.code;
    msg = err.msg;
    raw = err.raw;
  } else if (err instanceof Error) {
    code = CodeDBError;
    msg = err.message;
  } else if (typeof err === 'string') {
    msg = err;
  }

  const body: Envelope = { code, msg };
  if (raw !== undefined && raw !== null && !isProduction(c)) {
    body.error = raw instanceof Error ? raw.message : String(raw);
  }
  const cid = c.get('correlationId');
  if (typeof cid === 'string' && cid) {
    body.correlation_id = cid;
  }
  return jsonResponse(c, body);
}

/** 参数错误快捷方式。 */
export function paramError(c: Context, msg = 'Invalid parameters.'): Response {
  return fail(c, new AppError(CodeParamErr, msg));
}

function isProduction(c: Context): boolean {
  return (c.env as { ENVIRONMENT?: string } | undefined)?.ENVIRONMENT === 'production';
}

function jsonResponse(c: Context, body: Envelope): Response {
  // 与原版一致：HTTP 200 + 自定义业务码
  return c.json(body as never, 200);
}
