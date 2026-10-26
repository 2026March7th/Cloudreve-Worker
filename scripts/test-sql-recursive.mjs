/**
 * `resolvePath` / `ancestorNames` 两条递归 SQL 的语义回归（跑在 PGlite = WASM
 * 真 Postgres 上，不需要数据库服务）。
 *
 * 为什么值得单独立一个测试：这两条 SQL 是 2026-10-26 性能优化的核心 —— 把
 * 「每段一跳」的路径解析合成一次查询。而本地既没有 Postgres、也没有线上凭据，
 * 不跑真库就只能靠推理，推理最容易漏的恰恰是「路径不存在时 SQL 会返回走到
 * 最深的那一级」这种形状（所以 repo.ts 里才必须有深度 + 名字双校验）。
 *
 * 跑法：`npm run test:sql-recursive`
 */
import { PGlite } from '@electric-sql/pglite';

const RESOLVE = `
  WITH RECURSIVE walk(depth, id) AS (
    SELECT 0, $3::int
    UNION ALL
    SELECT w.depth + 1, f.id
    FROM walk w
    JOIN unnest($1::text[]) WITH ORDINALITY AS s(name, ord) ON s.ord = w.depth + 1
    JOIN files f ON f.file_children = w.id AND f.name = s.name AND f.owner_id = $2
  )
  SELECT f.*, w.depth AS _depth
  FROM walk w JOIN files f ON f.id = w.id
  ORDER BY w.depth DESC
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

/**
 * 与 `src/db/repo.ts` 的 resolvePath 逐行等价：取最深一级，再校验深度和名字，
 * 任一不符都返回 null（这一步就是「不存在的路径不会返回父目录」的保证）。
 */
async function resolvePath(elements, ownerId, rootId) {
  const { rows } = await db.query(RESOLVE, [elements, ownerId, rootId]);
  const hit = rows[0];
  if (!hit) return null;
  if (Number(hit._depth) !== elements.length) return null;
  if (String(hit.name) !== elements[elements.length - 1]) return null;
  return hit;
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
  `);

  console.log('\n[1] resolvePath：正常路径');
  let r = await resolvePath(['a'], 7, 1);
  check('一层', r?.id === 2, JSON.stringify(r));
  r = await resolvePath(['a', 'b', 'c'], 7, 1);
  check('三层', r?.id === 4 && Number(r._depth) === 3, JSON.stringify(r));
  r = await resolvePath(['a', 'b', 'c', 'd'], 7, 1);
  check('四层', r?.id === 5 && Number(r._depth) === 4, JSON.stringify(r));

  console.log('\n[2] resolvePath：不存在的路径必须为 null');
  check('首段就错', (await resolvePath(['zzz'], 7, 1)) === null);
  check('中间断裂', (await resolvePath(['a', 'zzz'], 7, 1)) === null);
  check('比真实层级深', (await resolvePath(['a', 'b', 'c', 'd', 'e'], 7, 1)) === null);

  console.log('\n[3] resolvePath：owner 隔离');
  check('同名不同主', (await resolvePath(['a'], 8, 6))?.id === 7);
  check('别人的路径不给查', (await resolvePath(['a', 'b'], 8, 6)) === null);

  console.log('\n[4] ancestorNames（pathOf 用）');
  check('叶子 → 全链', JSON.stringify(await pathSegments(5)) === JSON.stringify(['a', 'b', 'c', 'd']), JSON.stringify(await pathSegments(5)));
  check('一层', JSON.stringify(await pathSegments(2)) === JSON.stringify(['a']));
  check('根 → 空数组', (await pathSegments(1)).length === 0);
  check('只带 file_children 为 null 的项返回空（回收站项）', (await pathSegments(6)).length === 0);

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
