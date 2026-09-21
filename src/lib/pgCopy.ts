/**
 * PostgreSQL 文本复制编解码（`COPY ... TO/FROM STDIN WITH (FORMAT text)`）。
 *
 * 用途：把整库内容在主库与备库之间搬运（见 `db/replicate.ts`）。选文本
 * 格式而不是 `pg_dump` 或二进制格式，理由：
 *
 *   1. **不需要任何本机工具**。边缘版部署在 Workers 里，没有 shell、没有
 *      `pg_dump`、没有文件系统，唯一能用的就是 `sql\`...\``。而
 *      `COPY ... TO STDOUT` 的结果 Neon 的 HTTP 驱动会直接以字符串返回，
 *      天然可用。
 *   2. **跨版本安全**。文本格式是 Postgres 最稳定的对外表示，不依赖
 *      server 版本、字节序、OID。二进制格式两者版本不一致就炸。
 *   3. **可读**，出问题能直接看。
 *
 * ⚠️ 本模块只负责**编解码**这一纯逻辑（可在无数据库环境下单测）。
 * 实际的搬运流程在 `replicate.ts`。
 */

/** 文本格式的转义字符（Postgres `COPY` 默认 `\`）。 */
const ESCAPE = '\\';

/**
 * 单值编码（Postgres 文本格式，`\N` 表示 NULL）。
 *
 * 规则来自 Postgres 文档 `COPY` 一节：
 *   - NULL → `\N`
 *   - `\` → `\\`
 *   - 换行 `\n` → `\n`（字面反斜杠 + n）
 *   - 回车 `\r` → `\r`
 *   - 制表符 `\t` → `\t`
 *   - 退格 `\b`、换页 `\f`、垂直制表 `\v` 同理
 *   - 其余字符（含中文）原样输出 —— 文本格式是 UTF-8 直传，不做转义。
 */
export function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return `${ESCAPE}N`;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (v instanceof Date) return encodeDate(v);
  if (v instanceof Uint8Array) return encodeBytea(v);
  // jsonb / json 列：驱动返回的可能是对象（jsonb 自动解析）也可能是字符串，
  // 两种都要能还原成合法的 JSON 文本。
  if (typeof v === 'object') return escapeString(JSON.stringify(v));
  return escapeString(String(v));
}

/** 字符串转义。 */
function escapeString(s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case ESCAPE:
        out += `${ESCAPE}${ESCAPE}`;
        break;
      case '\n':
        out += `${ESCAPE}n`;
        break;
      case '\r':
        out += `${ESCAPE}r`;
        break;
      case '\t':
        out += `${ESCAPE}t`;
        break;
      case '\b':
        out += `${ESCAPE}b`;
        break;
      case '\f':
        out += `${ESCAPE}f`;
        break;
      case '\v':
        out += `${ESCAPE}v`;
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/**
 * 时间编码成 Postgres 能解析的 ISO 字符串。
 *
 * **不要**用 `toISOString()`：它带 `Z` 后缀（UTC 标记），而 `timestamptz`
 * 列虽然能接受，但 `timestamp`（无时区）列会把它当本地时间存下来，
 * 造成时区漂移。统一输出不带时区的 ISO 串，写回时由 Postgres 按列类型
 * 自行解释，与时区设置无关。
 */
function encodeDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return `${ESCAPE}N`;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

/**
 * bytea 编码成 `\x<hex>` 字面量。
 *
 * ⚠️ 关键细节：文本格式下 `bytea` 的输出是**双重转义**的 —— Postgres 会
 * 输出 `\\x0102`（两个反斜杠，因为原始内容里的 `\` 被转义了一次），
 * `COPY FROM` 也要吃这种形式。这里手工拼出 `\x` 后再过一次
 * `escapeString`，正好得到 `\\x`。
 */
function encodeBytea(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return escapeString(`\\x${hex}`);
}

/** 一行编码：各列用 `\t` 连接，行尾换行。 */
export function encodeRow(cols: readonly unknown[]): string {
  return `${cols.map(encodeValue).join('\t')}\n`;
}

/** 整表编码：表头（列名）+ 各数据行。 */
export function encodeCopyText(
  columns: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): string {
  const head = `${columns.map((c) => escapeString(c)).join('\t')}\n`;
  let body = '';
  for (const r of rows) body += encodeRow(r);
  return head + body;
}

/**
 * 解码一行的值为字符串数组（保留 `null` 语义为 `null`）。
 *
 * 主要用于**自检**：编码后的数据往返一趟应当与原值等价。真实导入一律走
 * `sql\`COPY ... FROM STDIN\`` 让 Postgres 自己解析，不用这个函数。
 */
export function decodeRow(line: string): Array<string | null> {
  const out: Array<string | null> = [];
  let cur = '';
  let i = 0;
  let wasNull = false;
  const push = () => {
    out.push(wasNull && cur === '' ? null : cur);
    cur = '';
    wasNull = false;
  };
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === ESCAPE) {
      const next = line[i + 1];
      if (next === undefined) {
        cur += ESCAPE;
        i += 1;
        continue;
      }
      if (next === 'N' && cur === '') {
        // `\N` 是 NULL，但不能立刻断定 —— `\Nx` 这种也只在首字符位置成立。
        // Postgres 的规则是「字段恰好为 \N」，所以先记账，遇到分隔符再定。
        wasNull = true;
        cur = '';
        i += 2;
        continue;
      }
      switch (next) {
        case 'n':
          cur += '\n';
          break;
        case 'r':
          cur += '\r';
          break;
        case 't':
          cur += '\t';
          break;
        case 'b':
          cur += '\b';
          break;
        case 'f':
          cur += '\f';
          break;
        case 'v':
          cur += '\v';
          break;
        case ESCAPE:
          cur += ESCAPE;
          break;
        default:
          cur += next;
      }
      i += 2;
      continue;
    }
    if (ch === '\t') {
      push();
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  push();
  return out;
}
