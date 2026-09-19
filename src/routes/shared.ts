/**
 * 路由层共用的小工具。放在单独文件里，避免 `admin.ts` 与 `admin-content.ts`
 * 互相 import 造成循环依赖。
 */
import type { HashIDCodec } from '../lib/hashid';

/**
 * 路径参数里的数字 ID。
 *
 * 上游是整数（`SingleStoragePolicyService.ID int \`uri:"id"\``），前端
 * `CommonMixin.id: number`，所以正常传进来就是 `"3"`。这里顺便兼容 hashid，
 * 免得早期写过 hashid 的书签或外部脚本失效。
 */
export function numericId(raw: string, decode: (s: string) => number | null): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  return decode(raw);
}

/**
 * 解包 `{ policy: {...} }` / `{ group: {...} }` / `{ user: {...} }` 这类信封。
 *
 * 上游的请求体都是 `{"policy": {...}}`（`CreateStoragePolicyService.Policy`），
 * 前端照这个发。同时兼容直接发裸对象，少一种踩坑姿势。
 */
export function unwrapBody<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
  key: string,
): T {
  const inner = body[key];
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as T;
  return body as T;
}

/** 前端的 `PaginationResults`（`api/explorer.ts:124`）。 */
export interface PaginationResults {
  page: number;
  page_size: number;
  total_items?: number;
  next_token?: string;
  is_cursor?: boolean;
}

/**
 * 归一化分页参数。
 *
 * 前端 `page` 从 0 开始（`AdminListService.page` 配合 `TablePagination` 用），
 * 上游 Go 侧做了 `binding:"min=1"` 但界面传 0 也能跑，这里统一成 0 基、夹住上限。
 */
export function paginationArgs(body: {
  page?: unknown;
  page_size?: unknown;
}): { page: number; pageSize: number; offset: number } {
  // 前端请求体里的 page 是 **1 基**（上游 AdminListService binding min=1），
  // 而上游 service 层统一 `Page: service.Page - 1` 传给 inventory，并以这个
  // **0 基**值回填响应 `pagination.page`（service/admin/user.go:64、
  // inventory/user.go:546）。之前这里漏了减 1，offset 直接 page*pageSize：
  // 第一页从第 N+1 条开始 —— 只有一个用户时用户列表永远为空，且响应
  // pagination.page 恒等于请求页码，前端 `setPage(page + 1)` 同步逻辑变成
  // 无限循环（节点页 URL pages 一路累加）。这里集中做 1 基 → 0 基转换。
  const page1 = Math.max(1, Math.floor(Number(body.page ?? 1)) || 1);
  const pageSize = Math.min(1000, Math.max(1, Number(body.page_size ?? 20) || 20));
  return { page: page1 - 1, pageSize, offset: (page1 - 1) * pageSize };
}

/** 组装响应里的 `pagination`。 */
export function paginationOf(page: number, pageSize: number, total: number): PaginationResults {
  return { page, page_size: pageSize, total_items: total };
}

/** 把只允许出现在 SQL 里的白名单列名挑出来，其余落到 fallback。 */
export function safeColumn(raw: unknown, allowed: readonly string[], fallback: string): string {
  const value = typeof raw === 'string' ? raw : '';
  return allowed.includes(value) ? value : fallback;
}

/** order_direction 只认 desc，其余按 asc 处理（与上游 `getOrderTerm` 的语义一致）。 */
export function safeDirection(raw: unknown): 'ASC' | 'DESC' {
  return typeof raw === 'string' && raw.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
}

/** 条件字典里的数字 ID，非法/空一律 null。 */
export function numericCondition(
  conditions: Record<string, string> | undefined,
  key: string,
): number | null {
  const raw = conditions?.[key];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 条件字典里的普通字符串。 */
export function stringCondition(
  conditions: Record<string, string> | undefined,
  key: string,
): string {
  return conditions?.[key] ?? '';
}

/** 条件字典里的布尔（上游 `setting.IsTrueValue`）。 */
export function boolCondition(
  conditions: Record<string, string> | undefined,
  key: string,
): boolean {
  const raw = conditions?.[key];
  if (!raw) return false;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** 统一的时间输出：驱动可能给 Date 也可能给字符串。 */
export function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 宽松取数字（Neon HTTP 会把 BIGINT 以字符串返回）。 */
export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export type { HashIDCodec };
