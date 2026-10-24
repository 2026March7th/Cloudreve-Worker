/**
 * 从节点读取。节点配置变动很少，但每次存储读写都要用到（策略 → node_id →
 * server/slave_key），所以加一层 isolate 缓存，避免每条上传分片都多一次跨区
 * 查询。管理端改动节点时调 `invalidateNodeCache` 失效。
 */
import type { Env } from '../env';
import type { NodeRow } from './types';
import { getSql } from './index';

const TTL_MS = 60_000;
/** 负缓存时间短一些：节点刚建好就绑策略的场景要能立刻用上 */
const NEGATIVE_TTL_MS = 5_000;

const cache = new Map<number, { at: number; row: NodeRow | null }>();

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value ?? 0));
}

function normalize(row: Record<string, unknown>): NodeRow {
  return {
    id: Number(row.id),
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
    deleted_at: row.deleted_at ? toDate(row.deleted_at) : null,
    name: String(row.name ?? ''),
    type: String(row.type ?? 'slave'),
    server: (row.server as string | null) ?? null,
    slave_key: (row.slave_key as string | null) ?? null,
    capabilities: (row.capabilities as string | null) ?? null,
    weight: row.weight === null || row.weight === undefined ? null : Number(row.weight),
    status: String(row.status ?? 'active'),
    settings: (row.settings as Record<string, unknown> | null) ?? null,
  };
}

/** 按 id 取节点（含已挂起/已删除判定），带 60 秒 isolate 缓存。 */
export async function loadNodeById(env: Env, id: number): Promise<NodeRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.at < (hit.row ? TTL_MS : NEGATIVE_TTL_MS)) return hit.row;

  const sql = getSql(env);
  const rows = (await sql`
    SELECT * FROM nodes WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
  `) as Record<string, unknown>[];
  const row = rows[0] ? normalize(rows[0]) : null;
  cache.set(id, { at: now, row });
  return row;
}

/** 存储策略必须绑定一个可用节点，否则这台 Worker 无处落盘。 */
export async function requireNode(env: Env, id: number | null | undefined): Promise<NodeRow> {
  if (!id) {
    throw new Error('This storage policy is not bound to any node');
  }
  const node = await loadNodeById(env, id);
  if (!node) throw new Error(`Node ${id} not found`);
  if (node.status !== 'active') throw new Error(`Node "${node.name}" is suspended`);
  return node;
}

/** 清缓存：`id` 省略时全清。 */
export function invalidateNodeCache(id?: number): void {
  if (id === undefined) cache.clear();
  else cache.delete(id);
}
