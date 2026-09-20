/**
 * 审计日志数据访问（audit_logs，migrations/0006_audit_log.sql）。
 *
 * 写入方 services/audit.ts（waitUntil fire-and-forget）；
 * 读取方 routes/admin.ts 的 GET /admin/audit/log（管理端「事件」页查看器）。
 */
import { getSql, toDate, toJson, toNum, toNumOrNull, type Sql } from './index';
import type { AuditLogRow } from './types';

function normalizeAuditLog(r: Record<string, unknown>): AuditLogRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    user_id: toNumOrNull(r.user_id),
    type: toNum(r.type),
    meta: toJson<Record<string, unknown>>(r.meta, {}),
  };
}

export class AuditRepo {
  private readonly sql: Sql;

  constructor(env: import('../env').Env) {
    this.sql = getSql(env);
  }

  async create(row: { user_id: number | null; type: number; meta: unknown }): Promise<void> {
    await this.sql`
      INSERT INTO audit_logs (user_id, type, meta)
      VALUES (${row.user_id}, ${row.type}, ${JSON.stringify(row.meta ?? {})}::jsonb)
    `;
  }

  /** 管理端列表：可按 type / user_id 过滤，page 为 1 基（响应里回 0 基，见 paginationArgs 惯例）。 */
  async list(args: {
    types?: number[];
    userId?: number;
    limit: number;
    offset: number;
  }): Promise<{ rows: AuditLogRow[]; total: number }> {
    const types = args.types && args.types.length ? args.types : null;
    const uid = typeof args.userId === 'number' && Number.isFinite(args.userId) ? args.userId : null;

    const rows = (
      await this.sql`
      SELECT id, created_at, user_id, type, meta
      FROM audit_logs
      WHERE (${types}::int[] IS NULL OR type = ANY(${types}::int[]))
        AND (${uid}::int IS NULL OR user_id = ${uid}::int)
      ORDER BY id DESC
      LIMIT ${args.limit} OFFSET ${args.offset}
    `
    ).map(normalizeAuditLog) as AuditLogRow[];

    const [{ count }] = (await this.sql`
      SELECT count(*)::int AS count FROM audit_logs
      WHERE (${types}::int[] IS NULL OR type = ANY(${types}::int[]))
        AND (${uid}::int IS NULL OR user_id = ${uid}::int)
    `) as Array<{ count: number }>;

    return { rows, total: count };
  }
}
