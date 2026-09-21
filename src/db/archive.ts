/**
 * 归档仓储（数据库侧）。
 *
 * 与 `services/archive.ts`（KV 侧）的分工：
 *
 *   - KV 侧（`archive.ts`）  ：小、热、短期 —— 如「上次的设置值」，
 *                            用于快速回滚展示。
 *   - DB 侧（本文件）        ：大、冷、长期 —— 归档表的**权威副本**，
 *                            可跨库分布、可按字段查询、不受 KV 单值 25MB 限制。
 *
 * ## 「只增不改」的强制点
 *
 * 表上有 BEFORE UPDATE / DELETE 触发器直接 RAISE（见 0010_archive.sql），
 * 所以这里**故意不提供** update / delete 方法 —— 提供了也执行不了。
 * 这个模块只做 `insert`（且带 ON CONFLICT DO NOTHING）+ `select`。
 *
 * ## 为什么 ON CONFLICT DO NOTHING 而不是 DO UPDATE
 *
 * 归档的语义是「第一条记录就是真相」。同一 (kind, object_id, at) 重复
 * 写入时**保留先到的**，后者忽略 —— 而不是用后到的覆盖。这保证了即使
 * 发生重放，归档内容也不会变。
 */
import type { Sql } from '../db';

/** 一条归档记录。 */
export interface ArchiveRow {
  entryId: string;
  kind: string;
  objectId: string;
  at: string;
  value: unknown;
  actor: string | null;
  note: string | null;
  source: number;
}

/** 数据库返回的原始行（snake_case）。 */
interface RawRow {
  entry_id: string;
  kind: string;
  object_id: string;
  at: string | Date;
  value: unknown;
  actor: string | null;
  note: string | null;
  source: number;
}

function toRow(r: RawRow): ArchiveRow {
  return {
    entryId: r.entry_id,
    kind: r.kind,
    objectId: r.object_id,
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    value: r.value,
    actor: r.actor,
    note: r.note,
    source: r.source,
  };
}

export class ArchiveRepo {
  constructor(private readonly sql: Sql) {}

  /**
   * **写一次**（write-once）：插入一条归档。
   *
   * - `entryId` 不存在则由调用方生成（UUID）；重复 id 会因主键冲突被忽略。
   * - 同一 `(kind, objectId, at)` 已存在时忽略（保留先到的）。
   * - 表上的触发器会拒绝任何 UPDATE/DELETE，所以这里只有插入一条路。
   *
   * @returns 真正插入了返回 `true`；因重复被忽略返回 `false`。
   */
  async putOnce(args: {
    kind: string;
    objectId: string | number;
    at: Date | string;
    value: unknown;
    actor?: string | number | null;
    note?: string | null;
    source?: number;
  }): Promise<boolean> {
    const entryId = crypto.randomUUID();
    const at = args.at instanceof Date ? args.at.toISOString() : args.at;
    const rows = (await this.sql`
      INSERT INTO archive_entries (entry_id, kind, object_id, at, value, actor, note, source)
      VALUES (
        ${entryId},
        ${args.kind},
        ${String(args.objectId)},
        ${at}::timestamptz,
        ${JSON.stringify(args.value)}::jsonb,
        ${args.actor != null ? String(args.actor) : null},
        ${args.note ?? null},
        ${args.source ?? 1}
      )
      ON CONFLICT DO NOTHING
      RETURNING entry_id
    `) as { entry_id: string }[];
    return rows.length > 0;
  }

  /** 某对象的归档历史，最新在前。 */
  async list(kind: string, objectId: string | number, limit = 50): Promise<ArchiveRow[]> {
    const rows = (await this.sql`
      SELECT entry_id, kind, object_id, at, value, actor, note, source
      FROM archive_entries
      WHERE kind = ${kind} AND object_id = ${String(objectId)}
      ORDER BY at DESC
      LIMIT ${limit}
    `) as RawRow[];
    return rows.map(toRow);
  }

  /** 取某对象**最近一次**归档（用于展示「改动前的值」）。 */
  async latest(kind: string, objectId: string | number): Promise<ArchiveRow | null> {
    const rows = await this.list(kind, objectId, 1);
    return rows[0] ?? null;
  }

  /** 归档总条数（诊断用）。 */
  async count(kind?: string): Promise<number> {
    const rows = (kind
      ? await this.sql`SELECT count(*)::int AS c FROM archive_entries WHERE kind = ${kind}`
      : await this.sql`SELECT count(*)::int AS c FROM archive_entries`) as { c: number }[];
    return Number(rows[0]?.c ?? 0);
  }
}

/**
 * 把归档写入**全部已配置的库**（主库 + 全部备库）。
 *
 * 归档表是「只增不改」的，所以在多个库上各存一份**不会互相冲突** ——
 * 这正是把备库用起来的正确姿势（备库不再只是等主库挂掉的冷备份）。
 *
 * 每个库独立 try/catch：某个库连不上不影响其他库，也不影响主流程。
 * 返回成功写入的库数（诊断用）。
 */
export async function archiveAcrossDatabases(
  sqls: Sql[],
  args: {
    kind: string;
    objectId: string | number;
    at: Date | string;
    value: unknown;
    actor?: string | number | null;
    note?: string | null;
  },
): Promise<number> {
  let ok = 0;
  for (const [i, sql] of sqls.entries()) {
    try {
      const inserted = await new ArchiveRepo(sql).putOnce({ ...args, source: i + 1 });
      // 重复（已存在）也算这个库「有这条归档」，计入成功。
      if (inserted || true) ok += 1;
    } catch {
      // 单库失败不影响其他库；归档不是业务必需路径。
    }
  }
  return ok;
}
