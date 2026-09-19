/**
 * Neon (PostgreSQL) 访问层。
 *
 * 用 `@neondatabase/serverless` 的 HTTP 驱动，在 Workers 里无需 TCP 连接池，
 * 每次查询就是一次 fetch。注意两点与本地 Postgres 驱动的差异：
 *
 *   1. BIGINT 通过 HTTP 以 **字符串** 返回（避免 JSON 精度丢失），
 *      所有读取路径都要过 `toNum()`。
 *   2. BYTEA 返回 **十六进制字符串**（`\x0102` 形式）。
 *      所有读取路径都要过 `toBytes()`。
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from '../env';

export type Sql = NeonQueryFunction<false, false>;

const clients = new WeakMap<object, Sql>();

/** 取（并缓存）当前 env 对应的 SQL 客户端。 */
export function getSql(env: Env): Sql {
  const cached = clients.get(env);
  if (cached) return cached;
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  const sql = neon(env.DATABASE_URL);
  clients.set(env, sql);
  return sql;
}

/**
 * 把可能以字符串形式返回的 BIGINT / NUMERIC 归一化成 number。
 * 数据库里 size / storage 这类值不可能超过 Number.MAX_SAFE_INTEGER
 * （2^53 字节 ≈ 9 PB），因此直接转换是安全的。
 */
export function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 同上，但保留 null 语义。 */
export function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return toNum(v);
}

/** 把 bytea 列归一化成 Uint8Array。 */
export function toBytes(v: unknown): Uint8Array {
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    let hex = v;
    if (hex.startsWith('\\x')) hex = hex.slice(2);
    else if (hex.startsWith('0x')) hex = hex.slice(2);
    if (hex.length === 0) return new Uint8Array(0);
    // 容错：奇数长度时左侧补 0
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array(0);
}

/** 把 Uint8Array 编码成 Postgres 的 bytea 十六进制字面量。 */
export function toByteaLiteral(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

/** JSON 列：驱动可能返回对象，也可能是字符串，统一解成对象。 */
export function toJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof v === 'object') return v as T;
  return fallback;
}

/** 时间列：驱动可能返回 Date 对象，也可能是 ISO 字符串。 */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}
