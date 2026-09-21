/**
 * SQL 文本 → 语句数组的**唯一实现**（全仓库只此一份，禁止再复制）。
 *
 * 使用方：
 *   - src/db/provision.ts（Worker 运行时自举，esbuild 打包进 Worker）
 *   - scripts/db-sync.mjs（构建期备库自动建表）
 *   - scripts/migrate.mjs（开发期手动迁移）
 *   - scripts/test-db-schema-sync.mjs（真机测试 —— 测的就是这份代码）
 *
 * ## 为什么必须是状态机，而不是「去注释 + split(';')」
 *
 * 0010_archive.sql 用 $$...$$ 包了一段 PL/pgSQL 函数体，函数体里有分号
 * （`RAISE ...;` 和 `END;`）。旧的朴素切分把函数体拦腰截成三段，Postgres
 * 对第一段报 `unterminated dollar-quoted string`，自举失败，全站 503
 * （2026-09-21 生产事故，cf 日志 18/18 全部同一错误）。
 * 所以这里的每一条词法规则都不是装饰：单引号、双引号、dollar-quote、
 * 行注释、块注释（含 Postgres 的嵌套块注释）都必须跳过去找真正的语句边界。
 *
 * ## 已知局限（对本仓库迁移文件无影响，新增迁移内容前先确认）
 *
 *   - 不处理 E'...' / U&'...' 转义串里的 `\'` 反斜杠转义；
 *   - 假定 standard_conforming_strings=on（现代默认值，反斜杠是普通字符）。
 *   已核对 migrations/ 目录当前不存在这两类内容。
 *
 * 注释整体丢弃（与旧实现一致），语句两端空白 trim 掉，纯注释/纯分号
 * 不产出空语句。文件未被 dollar-quote/引号包裹的 `;` 是唯一语句边界。
 */

/** @param {string} sqlText @returns {string[]} */
export function splitStatements(sqlText) {
  const statements = [];
  let cur = '';
  const n = sqlText.length;
  let i = 0;

  const flush = () => {
    const s = cur.trim();
    if (s) statements.push(s);
    cur = '';
  };

  while (i < n) {
    const ch = sqlText[i];
    const ch2 = i + 1 < n ? sqlText[i + 1] : '';

    // 行注释：-- 直到行尾。注释内容整体丢弃；换行符留给下一轮当普通字符，
    // 以保持语句内的换行结构（与旧行为一致）。
    if (ch === '-' && ch2 === '-') {
      const nl = sqlText.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl;
      continue;
    }

    // 块注释：/* ... */。Postgres 允许嵌套（/* /* */ */ 是合法的一整块），
    // 必须按深度配对。丢内容、留一个空格，防止相邻 token 被粘连。
    if (ch === '/' && ch2 === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sqlText[i] === '/' && sqlText[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sqlText[i] === '*' && sqlText[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      cur += ' ';
      continue;
    }

    // 单引号字符串：'' 是转义的引号，字符串内的 ; -- /* $$ 都不是边界。
    if (ch === "'") {
      cur += sqlText[i++];
      while (i < n) {
        const c = sqlText[i++];
        cur += c;
        if (c === "'") {
          if (sqlText[i] === "'") {
            cur += "'";
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // 双引号标识符："" 是转义的引号（基理同上）。
    if (ch === '"') {
      cur += sqlText[i++];
      while (i < n) {
        const c = sqlText[i++];
        cur += c;
        if (c === '"') {
          if (sqlText[i] === '"') {
            cur += '"';
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // dollar-quote：$$ 与 $tag$（tag = 字母/下划线开头，可含数字/下划线）。
    // $1 这类参数占位符不是 dollar-quote —— tag 不能以数字开头，
    // 所以 `$` 后紧跟数字时按普通字符处理（与 Postgres 词法一致）。
    // 结束符必须与开始符逐字节相同；找不到结束符就把余文全部并入当前
    // 语句，让 Postgres 自己报 unterminated dollar-quoted string ——
    // 不要比数据库「聪明」。
    if (ch === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sqlText[j])) j++;
      const isDollarQuote =
        sqlText[j] === '$' && (j === i + 1 || /[A-Za-z_]/.test(sqlText[i + 1]));
      if (isDollarQuote) {
        const delim = sqlText.slice(i, j + 1);
        const close = sqlText.indexOf(delim, j + 1);
        const end = close === -1 ? n : close + delim.length;
        cur += sqlText.slice(i, end);
        i = end;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    // 唯一的语句边界：不在任何词法单元内部的分号。
    if (ch === ';') {
      flush();
      i++;
      continue;
    }

    cur += ch;
    i++;
  }
  flush();
  return statements;
}
