/**
 * 负载均衡虚拟策略离线测试。
 * 用法: node scripts/test-load-balance.mjs
 *
 * 覆盖（src/storage/loadBalance.ts）：
 *  - expandLoadBalance：空配置报错 / 过滤已删除与无驱动类型 / 去重排序
 *  - pickSlavePolicy：单 slave 直选；random 落在集合内；round_robin 轮流
 *  - validateLoadBalanceSettings：空列表 / 不存在的策略 / 嵌套 LB / 非法算法
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'lb-test-'));
const outfile = join(tmp, 'lb-bundle.mjs');
await build({
  entryPoints: [new URL('../src/storage/loadBalance.ts', import.meta.url).pathname.slice(1)],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile,
  external: ['cloudflare:*'],
  loader: { '.sql': 'text' },
  logLevel: 'silent',
});

const lb = await import(pathToFileURL(outfile).href);
rmSync(tmp, { recursive: true, force: true });

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    console.error(`FAIL  ${msg}`);
    failed++;
  }
};

const mkPolicy = (id, type, settings = {}) => ({
  id,
  name: `policy-${id}`,
  type,
  settings,
  created_at: new Date(),
  updated_at: new Date(),
});

const S3 = (id, settings) => mkPolicy(id, 's3', settings);
const ctx = (rows) => ({
  policies: {
    async byIds(ids) {
      return rows.filter((r) => ids.includes(r.id));
    },
  },
});

// ---- expandLoadBalance ----
{
  const empty = mkPolicy(9, 'load_balance', {});
  await lb
    .expandLoadBalance(ctx([]), empty)
    .then(() => ok(false, 'expand: 空配置应报错'))
    .catch((e) => ok(e.message.includes('没有配置任何存储策略'), 'expand: 空配置报明确错误'));

  // slave 3 不存在；slave 4 是 local（无驱动）→ 只剩 1、2，按 id 排序
  const lbPolicy = mkPolicy(9, 'load_balance', { slave_policy_ids: [2, 3, 1, 4, 2, 0, -1] });
  const rows = [S3(1), S3(2), mkPolicy(4, 'local')];
  const expanded = await lb.expandLoadBalance(ctx(rows), lbPolicy);
  ok(
    JSON.stringify(expanded.map((p) => p.id)) === '[1,2]',
    'expand: 过滤不存在/无驱动/去重/排序',
  );

  const allGone = mkPolicy(9, 'load_balance', { slave_policy_ids: [4] });
  await lb
    .expandLoadBalance(ctx([mkPolicy(4, 'local')]), allGone)
    .then(() => ok(false, 'expand: 全不可用应报错'))
    .catch((e) => ok(e.message.includes('均不可用'), 'expand: 全不可用报明确错误'));
}

// ---- pickSlavePolicy ----
{
  const single = mkPolicy(9, 'load_balance', { slave_policy_ids: [1] });
  const picked = await lb.pickSlavePolicy(ctx([S3(1)]), single);
  ok(picked.id === 1, 'pick: 单 slave 直选');

  const lbPolicy = mkPolicy(9, 'load_balance', {
    slave_policy_ids: [1, 2, 3],
    load_balance_mode: 'random',
  });
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const p = await lb.pickSlavePolicy(ctx([S3(1), S3(2), S3(3)]), lbPolicy);
    seen.add(p.id);
    ok(seen.has(p.id), `pick: random 落在集合内（${p.id}）`) && void 0;
    if (![1, 2, 3].includes(p.id)) {
      ok(false, `pick: random 越界 ${p.id}`);
      break;
    }
  }
  ok(seen.size >= 2, `pick: random 有分散性（覆盖 ${seen.size}/3）`);

  const rr = mkPolicy(9, 'load_balance', {
    slave_policy_ids: [1, 2, 3],
    load_balance_mode: 'round_robin',
  });
  const seq = [];
  for (let i = 0; i < 6; i++) {
    seq.push((await lb.pickSlavePolicy(ctx([S3(1), S3(2), S3(3)]), rr)).id);
  }
  // 第一次随机起点，之后严格轮流（i+1)%n
  const start = seq[0];
  const expected = [0, 1, 2, 0, 1, 2].map((k) => (start - 1 + 1 + k - 1 + 3) % 3 + 1);
  // 直接验证「相邻不同 + 周期 3」：后 5 个应满足 (prev % 3) + 1
  const cyclic = seq.slice(1).every((id, i) => {
    const prev = seq[i];
    return id === (prev % 3) + 1;
  });
  ok(cyclic, `pick: round_robin 严格轮流（起点 ${start}，序列 ${seq.join(',')}, expected tail ${expected.join(',')}）`);
}

// ---- validateLoadBalanceSettings ----
{
  const repo = ctx([S3(1), mkPolicy(4, 'local'), mkPolicy(5, 'load_balance')]).policies;
  const expectFail = async (settings, kw) => {
    try {
      await lb.validateLoadBalanceSettings(repo, settings);
      ok(false, `validate: 应拒绝 ${kw}`);
    } catch (e) {
      ok(e.message.includes(kw), `validate: ${kw}`);
    }
  };
  await lb.validateLoadBalanceSettings(repo, { slave_policy_ids: [1] }).then(() => ok(true, 'validate: 合法配置通过'));
  await expectFail({}, '至少需要选择一个存储策略');
  await expectFail({ slave_policy_ids: [] }, '至少需要选择一个存储策略');
  await expectFail({ slave_policy_ids: [1, 99] }, '不存在的存储策略');
  await expectFail({ slave_policy_ids: [4] }, '类型在此部署不可用');
  await expectFail({ slave_policy_ids: [5] }, '不支持嵌套负载均衡');
  await expectFail({ slave_policy_ids: [1], load_balance_mode: 'hash' }, 'random / round_robin');
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过 ✓');
