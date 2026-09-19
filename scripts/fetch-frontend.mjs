#!/usr/bin/env node
/**
 * 确保仓库根目录下有官方前端构建产物（frontend/），供 wrangler.toml 的
 * [assets] 使用。前端源码不入库，按以下顺序获取：
 *
 *   1. frontend/index.html 已存在 → 直接用（上次构建/部署留下的产物）。
 *   2. 本仓库 GitHub Release（tag `frontend-assets`）里的 frontend.tar.gz
 *      → 下载解压，秒级完成。私有仓库或没发过 Release 会 404，自动走 3。
 *   3. 拉取上游 cloudreve/frontend 源码（固定 COMMIT，与上游 .gitmodules
 *      一致），在本机/构建机上 yarn install + vite build。
 *
 * `npm run build` 和 `npm run deploy` 都会先跑本脚本，所以 Cloudflare
 * 面板的两格命令不需要变。任何一步失败都会带出真实报错并以非零码退出。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'frontend');
const TARBALL_PATH = path.join(ROOT, '_frontend.tar.gz');
const SRC_DIR = path.join(ROOT, '_frontend-src');

/** 上游 .gitmodules 固定的前端提交，更新前端版本就改这里。 */
const COMMIT = '19da0fe1ecd40971fafa813983d769fdce41573c';
const UPSTREAM_TARBALL = `https://codeload.github.com/cloudreve/frontend/tar.gz/${COMMIT}`;
const RELEASE_TAG = 'frontend-assets';
const RELEASE_ASSET = `frontend-${COMMIT.slice(0, 7)}.tar.gz`;

/** npx 在 Windows 上需要 shell；CI 是 Linux。 */
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npxArgs = (args) => (process.platform === 'win32' ? args : ['--yes', ...args]);

function run(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: cwd || ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  return { code: r.status ?? 1, all: `${r.stdout || ''}${r.stderr || ''}` };
}

function runOrDie(cmd, args, label, opts) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = run(cmd, args, opts);
  if (r.code !== 0) {
    console.error(`\n✘ ${label} 失败（exit ${r.code}）：\n${r.all}`);
    process.exit(r.code);
  }
  return r;
}

function cleanup() {
  rmSync(TARBALL_PATH, { force: true });
  rmSync(SRC_DIR, { recursive: true, force: true });
}

// --- 1. 已有产物 ---
if (existsSync(path.join(TARGET, 'index.html'))) {
  console.log('  frontend/ 已存在，直接复用。');
  process.exit(0);
}
console.log('  未发现 frontend/，开始获取官方前端…');
cleanup();

// --- 2. 同仓库 Release 里的预构建包（公开仓库时走这条，秒级） ---
try {
  const origin = run('git', ['remote', 'get-url', 'origin']);
  const m = origin.all.match(/github\.com[/:]([^/]+)\/([^/.]+)\.git/);
  if (m && process.env.CLOUDREV_FE_RELEASE !== '0') {
    const url = `https://github.com/${m[1]}/${m[2]}/releases/download/${RELEASE_TAG}/${RELEASE_ASSET}`;
    console.log(`  尝试从 Release 下载预构建包：${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (res.ok) {
      writeFileSync(TARBALL_PATH, Buffer.from(await res.arrayBuffer()));
      runOrDie('tar', ['-xzf', TARBALL_PATH, '-C', ROOT], '解压前端产物');
      const inner = path.join(SRC_DIR, RELEASE_ASSET.replace('.tar.gz', ''));
      rmSync(TARGET, { recursive: true, force: true });
      cpSync(inner, TARGET, { recursive: true });
      cleanup();
      if (existsSync(path.join(TARGET, 'index.html'))) {
        console.log('✅ 前端就绪（Release 预构建包）。');
        process.exit(0);
      }
      console.log('  Release 包内容异常，回退到源码构建。');
      cleanup();
    } else {
      console.log(`  下载失败（HTTP ${res.status}，私有仓库/未发布 Release 时属正常），改从源码构建。`);
    }
  }
} catch (e) {
  console.log(`  Release 路径不可用（${e?.message || e}），改从源码构建。`);
}
cleanup();

// --- 3. 上游源码，本机/构建机构建 ---
console.log(`  下载上游源码（cloudreve/frontend @ ${COMMIT.slice(0, 7)}）…`);
const res = await fetch(UPSTREAM_TARBALL, { redirect: 'follow' });
if (!res.ok) {
  console.error(`✘ 源码下载失败：HTTP ${res.status}（${UPSTREAM_TARBALL}）`);
  process.exit(1);
}
writeFileSync(TARBALL_PATH, Buffer.from(await res.arrayBuffer()));

mkdirSync(SRC_DIR, { recursive: true });
runOrDie('tar', ['-xzf', TARBALL_PATH, '-C', SRC_DIR], '解压源码');
const src = path.join(SRC_DIR, `frontend-${COMMIT}`);
if (!existsSync(src)) {
  console.error(`✘ 解压后找不到源码目录：${src}`);
  process.exit(1);
}

console.log('  安装前端依赖（首次约 1-3 分钟）…');
runOrDie(
  NPX,
  npxArgs(['yarn@1.22.22', 'install', '--frozen-lockfile']),
  'yarn install',
  { cwd: src, env: { HUSKY: '0', NODE_OPTIONS: '--max-old-space-size=6144' } },
);

console.log('  构建前端（vite build，约 1-4 分钟）…');
runOrDie(NPX, npxArgs(['yarn@1.22.22', 'run', 'build']), 'yarn build', {
  cwd: src,
  env: { HUSKY: '0', NODE_OPTIONS: '--max-old-space-size=6144' },
});

const built = path.join(src, 'build');
if (!existsSync(path.join(built, 'index.html'))) {
  console.error(`✘ 构建产物里没有 index.html：${built}`);
  process.exit(1);
}
rmSync(TARGET, { recursive: true, force: true });
cpSync(built, TARGET, { recursive: true });
cleanup();

console.log(`✅ 官方前端就绪：${TARGET}`);
