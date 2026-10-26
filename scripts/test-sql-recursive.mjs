/**
 * 路径解析与祖先链的 SQL 语义回归（跑在 PGlite = WASM 真 Postgres 上）。
 *
 * 覆盖 `resolvePath`（逐段 childByName，配 ensureRoot 的 isolate 缓存）与
 * `ancestorNames`（pathOf 用的一次递归查询）。
 *
 * ⚠️ resolvePath **故意不用** `WITH RECURSIVE`：线上实测（Server-Timing 分段）
 * 递归 CTE 单条 500~1900ms，而带索引的简单查询 ~165ms —— `unnest` 进递归项后
 * 计划器不走向索引。改回来之前先跑这个测试和线上分段数据对比。
 *
 * 跑法：`npm run test:sql-recursive`
 */
import { PGlite } from '@electric-sql/pglite';

/** 与 `FileRepo.childByName` 逐字一致。 */
const CHILD_BY_NAME = `
  SELECT * FROM files
  WHERE name = $1
    AND (($2::int IS NULL AND file_children IS NULL) OR file_children = $2)
  LIMIT 1`;

const ANCESTORS = `
  WITH RECURSIVE up(id, name, parent, depth) AS (
    SELECT id, name, file_children, 0 FROM files WHERE id = $1
    UNION ALL
    SELECT f.id, f.name, f.file_children, u.depth + 1
    FROM files f JOIN up u ON f.id = u.parent
  )
  SELECT name, depth FROM up WHERE name <> '' ORDER BY depth ASC`;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
};

const db = new PGlite();

async function childByName(parentId, name) {
  const { rows } = await db.query(CHILD_BY_NAME, [name, parentId]);
  return rows[0] ?? null;
}

/** 与 `resolvePath` 一致：从根逐段向下，任何一段缺失即 null。 */
async function resolvePath(ownerId, elements) {
  const root = await db.query(
    `SELECT * FROM files WHERE owner_id = $1 AND file_children IS NULL AND name = '' LIMIT 1`,
    [ownerId],
  );
  let current = root.rows[0];
  if (!current) return null;
  for (const el of elements) {
    const next = await childByName(current.id, el);
    if (!next) return null;
    current = next;
  }
  return current;
}

/** 与 `pathOf()` 一致：由浅到深的名字数组，根返回空。 */
async function pathSegments(id) {
  const { rows } = await db.query(ANCESTORS, [id]);
  return rows.map((r) => r.name).reverse();
}

try {
  await db.exec(`
    CREATE TABLE files (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      owner_id INT NOT NULL,
      file_children INT,
      type INT NOT NULL DEFAULT 0,
      size BIGINT NOT NULL DEFAULT 0,
      is_symbolic BOOL NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 用户 7：root(1) → a(2) → b(3) → c(4) → d(5)
    -- 用户 8：另一个 root(6)，下面也有一个 a(7) —— 验证 owner 隔离
    INSERT INTO files (id, name, owner_id, file_children) VALUES
      (1, '', 7, NULL), (2, 'a', 7, 1), (3, 'b', 7, 2), (4, 'c', 7, 3), (5, 'd', 7, 4),
      (6, '', 8, NULL), (7, 'a', 8, 6);
    CREATE UNIQUE INDEX IF NOT EXISTS file_file_children_name ON files (file_children, name);
  `);

  console.log('\n[1] resolvePath：正常路径');
  let r = await resolvePath(7, ['a']);
  check('一层', r?.id === 2, JSON.stringify(r));
  r = await resolvePath(7, ['a', 'b', 'c']);
  check('三层', r?.id === 4, JSON.stringify(r));
  r = await resolvePath(7, ['a', 'b', 'c', 'd']);
  check('四层', r?.id === 5, JSON.stringify(r));

  console.log('\n[2] resolvePath：不存在的路径必须为 null');
  check('首段就错', (await resolvePath(7, ['zzz'])) === null);
  check('中间断裂', (await resolvePath(7, ['a', 'zzz'])) === null);
  check('比真实层级深', (await resolvePath(7, ['a', 'b', 'c', 'd', 'e'])) === null);

  console.log('\n[3] owner 隔离');
  r = await resolvePath(8, ['a']);
  check('同名不同主 → 用户 8 自己的 a', r?.id === 7, JSON.stringify(r));
  check('别人的子路径不给查', (await resolvePath(8, ['a', 'b'])) === null);

  console.log('\n[4] childByName 的 NULL 语义');
  const rootHit = await childByName(null, '');
  check('parentId=null + name="" → 根', rootHit?.id === 1, JSON.stringify(rootHit));

  console.log('\n[5] ancestorNames（pathOf 用）');
  check('叶子 → 全链', JSON.stringify(await pathSegments(5)) === JSON.stringify(['a', 'b', 'c', 'd']), JSON.stringify(await pathSegments(5)));
  check('一层', JSON.stringify(await pathSegments(2)) === JSON.stringify(['a']));
  check('根 → 空数组', (await pathSegments(1)).length === 0);
  check('file_children 为 null 的项返回空（回收站项）', (await pathSegments(6)).length === 0);

  console.log(
    `\n${failed === 0 ? '全部通过' : `${failed} 项不通过`}（${passed} 项通过，${failed} 项失败）`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('测试异常：', err);
  process.exitCode = 1;
} finally {
  await db.close();
}
