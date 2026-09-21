# Cloudreve-Worker

把 Cloudreve v4 的后端**重写**成可跑在 Cloudflare Workers 上的 TypeScript 实现
（不是编译、不是移植 —— Go 跑不了 Workers）。


---

## 一键部署


1. 打开 [neon.tech](https://neon.tech) 注册（可用 GitHub 登录），新建项目，复制首页的 **Connection string**（`postgresql://...` 那串）。
2. 点部署按钮：

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

3. 部署页把 `DATABASE_URL` 填成第 1 步的连接串，点 **Deploy**。KV 和 R2 自动创建，建表和初始化在**首次打开站点时自动完成**。
4. 打开 Worker 地址，注册第一个账号 —— **第一个注册的用户自动是管理员**。
5. 收尾：Worker 设置 → 变量，把 `SITE_URL` 改成这个 Worker 地址。

### 不用按钮，在面板手动接 fork 的仓库

Workers & Pages → Create → 选仓库，只填两格：

| 框 | 命令 |
|---|---|
| **构建命令** | `npm install` |
| **部署命令** | `npm run deploy` |

输出目录留空。`npm run deploy` 会自动处理 KV 和 R2：**账号里已有同名资源就直接连过来用，没有才新建**，并把真实 ID 回填，不需要改 `wrangler.toml`。

然后在项目的**设置 → 环境变量**里添加 `DATABASE_URL`（第 1 步的连接串），保存后重新部署 —— 部署脚本会自动把它写入 Worker 的运行时 Secret，不用再去面板手动加。`SITE_URL` 同样加在这个环境变量里即可。

## 环境变量

部署页只要求填 `DATABASE_URL` 一项，其余全部可选——想要时自己在面板（Workers → 设置 → 变量和机密）里加，不加也能跑：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon 连接串。加在部署项目的环境变量里，`npm run deploy` 会自动写成运行时 Secret；也可部署后在 Worker 的「变量和机密」里手动加 |
| `SITE_URL` | 建议 | 站点对外地址（Worker 地址），分享短链 / 下载直链用它；不设则回落到管理后台的 `siteURL` 设置 |
| `JWT_SECRET` | 可选 | 令牌签名密钥（32 位以上随机串）。不设会自动生成并入库 |
| `FRONTEND_URL` | 可选 | 官方前端默认已随 Worker 一起发布；只有把前端单独部署到别处（如 Pages）时才填，填了反代优先于内置资源 |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | 可选 | 兜底管理员：两者都配置后，Worker 保证该邮箱存在、密码一致、属于管理员组。用于找回管理员权限（手机部署没有本机 CLI）。建议存成 **Secret**；网页里改过密码后只要不动这对变量就不会被覆盖，删掉变量则完全不再干预 |
| `DATABASE_URL_2` … `DATABASE_URL_5` | 可选 | 备库连接串（自己另外建的 Neon 项目）。配了之后**每次构建会自动把主库整库全量同步过去**，作为容灾备份。最多 4 个备库（含主库合计 5 个） |
| `KV_COUNT` | 可选 | 建几个 KV namespace，取值 **1–5**，默认 1。超过 5 直接拒绝构建。⚠️ **必须配在构建环境能读到的地方**，见下方「多个 KV / 多个数据库」 |
| `DB_FAILOVER` | 可选 | 填 `1` 打开主库故障切换：主库连不上时自动降级到第一个备库。⚠️ 切换期间写到备库的数据会在下次构建全量同步时被覆盖，仅作临时应急 |

邮件、全文检索（Meilisearch + Tika）、存储策略等全部在**管理后台**配置，不占环境变量。详见 [DEPLOY.md](./DEPLOY.md)。

> ⚠️ **`KV_COUNT` 不要填在「Workers → 设置 → 变量和机密」里。** 那是**运行时**变量，
> 而绑定数量必须在**构建时**确定，构建过程读不到它 —— 结果就是它静默落回默认值 1，
> 你以为配了 5 个但只绑了 1 个，而且站点不报错。正确位置见下一节。

## 多个 KV / 多个数据库

单 KV / 单库在并发高时会撞上两类瓶颈：**KV 的写入限速**（同一 namespace 每秒写次数有限）和**单个 Neon 计算实例的连接/CPU 上限**。两者都能靠加实例摊薄，但机制完全不同，别混为一谈。

### KV：加数量 = 按角色分工（`KV_COUNT=1..5`）

KV **只做缓存**，不存业务数据。加多个不是做哈希分片，而是**按用途分开**——这样调大 `KV_COUNT` 只是让原本挤在一个 namespace 里的几类流量各走各的，**不会让已有缓存失效**：

| 角色 | 绑定 | 存什么 |
|---|---|---|
| `site` | `KV_1` | 站点设置缓存 |
| `session` | `KV_2` | 登录会话、验证码、2FA 挑战、OAuth/OIDC 临时态 |
| `upload` | `KV_3` | 上传会话、分片上传、打包下载会话、WebDAV 锁 |
| `cred` | `KV_4` | 外部服务凭据缓存（OneDrive token、OIDC discovery） |
| `flag` | `KV_5` | 自举 / 迁移标记 |

`KV_COUNT=1` 时只有一个 namespace，五个角色共用它，键名自动加 `角色:` 前缀避免互相覆盖。调大 `KV_COUNT` 后重新构建，`scripts/setup-kv.mjs` 会把 `KV_1..KV_n` 写进 `wrangler.toml`；某个角色找不到自己的绑定就逐级回落到裸 `KV`，所以**任何时刻都不会因为少配绑定而报错**。

> Cloudflare 的 KV 绑定是编译期静态配置，不能在运行时新建。所以 `KV_COUNT` 是**构建/部署期**生效的：改完重新部署一次即可。`npm run deploy` 会自动创建缺的 namespace，不需要手工去面板点。

#### `KV_COUNT` 要填在哪里（这一步最容易错）

绑定数量在**构建时**就要定下来，所以这个值必须放在**构建过程读得到**的地方：

| 位置 | 生效 | 说明 |
|---|---|---|
| 仓库根目录的 `KV_COUNT` 文件 | ✅ **推荐** | 内容就是一个数字（如 `5`）。随仓库走，永久生效，不依赖任何平台配置 —— 最不容易出错。本仓库已提交该文件 |
| GitHub：Settings → Secrets and variables → Actions → **Variables** | ✅ | 加 `KV_COUNT=5`。仓库自带 CI 会读到 |
| Workers Builds 的环境变量 | ✅ | 面板 → Workers & Pages → 项目 → 设置 → **构建** → 环境变量 |
| Workers → 设置 → **变量和机密** | ❌ **无效** | 这是**运行时**变量，构建时读不到，会被静默忽略 |

优先级：`--count` 参数 > 环境变量 > `KV_COUNT` 文件 > 默认 1。脚本每次都会打印实际读到什么、从哪读的：

```
  KV_COUNT = 5（来源：文件 KV_COUNT）
✔ KV 绑定已装配：KV_COUNT=5 → 声明 KV_1..KV_5 + 兜底 KV（共 6 个绑定）
```

**怎么确认线上真的生效了**：访问 `https://你的域名/api/v4/site/kv-status`，它会回显实际绑定与每个角色落到哪个 namespace：

```json
{ "bindings": ["KV","KV_1","KV_2","KV_3","KV_4","KV_5"],
  "kv_count": 5,
  "roles": { "site": "KV_1", "session": "KV_2", "upload": "KV_3", "cred": "KV_4", "flag": "KV_5" },
  "distinct_namespaces": 5 }
```

`distinct_namespaces` 为 `1` 就说明多 KV 没生效（所有角色都退回了兜底 `KV`）。

### Neon：加数量 = 主备容灾（`DATABASE_URL_2..5`）

**只有一个库可写**（`DATABASE_URL`，主库）。备库是**冷备**：平时不接流量，每次构建时从主库**全量覆盖**一次，主库真挂了可以临时用 `DB_FAILOVER=1` 切过去顶上。

这里有个必须讲清的取舍：**「备库接流量」和「构建时全量覆盖」不能同时成立**——只要备库接受过写入，下一次全量同步就会把这些写入抹掉。所以本项目选择前者让位后者：备库只读，换来「备份内容永远等于主库快照」这个确定性。真要双活写入，得做主从复制（Neon 上属于付费能力），不是这套机制能提供的。

> **所以「我绑了 5 个库」的正常表现就是：只有主库在处理读写，另外 4 个平时是安静的。** 这不是没生效 —— 它们是备份，备份的用途就是平时不动。判断有没有生效看下面两条，不要看「请求打到了哪个库」。

#### `DATABASE_URL_2..5` 要填在哪里

和 KV 不同，数据库连接串**运行时要读**（Worker 用它连库），**构建时也要读**（CI 用它做全量同步）。所以位置分两处：

| 位置 | 构建期同步用 | 运行时连库用 | 说明 |
|---|---|---|---|
| Cloudflare 面板 → 该 Worker → 设置 → **变量和机密** | ❌ | ✅ **必须配** | Worker 运行时只认这里。5 个库都要加进来 |
| GitHub：Settings → Secrets → Actions | ✅ **必须配** | ❌ | CI 靠它跑「主库 → 备库全量同步」 |
| Workers Builds → 设置 → 构建 → 环境变量 | ✅ | ❌ | 同上，作用于构建过程 |
| 仓库 `.dev.vars`（本机） | ✅ | — | 只在 `wrangler dev` / 本机脚本生效，不入库 |

**两边都要配**。只配了 GitHub Secrets：构建日志里能看到同步成功，但 Worker 运行时读不到 `DATABASE_URL_2..5`，等于只有主库在跑。只配了面板：运行时有，但每次构建不会自动同步，备库会一直是空的。

#### 怎么确认 5 个库真的被运行时用上了

```bash
curl https://你的域名/api/v4/site/db-status
```

```json
{ "present": [
    { "name": "DATABASE_URL",   "present": true, "host": "ep-aaa.aws.neon.tech" },
    { "name": "DATABASE_URL_2", "present": true, "host": "ep-bbb.aws.neon.tech" },
    { "name": "DATABASE_URL_3", "present": true, "host": "ep-ccc.aws.neon.tech" },
    { "name": "DATABASE_URL_4", "present": true, "host": "ep-ddd.aws.neon.tech" },
    { "name": "DATABASE_URL_5", "present": true, "host": "ep-eee.aws.neon.tech" }
  ],
  "database_count": 5,
  "backup_count": 4,
  "failover_enabled": false,
  "single_writer": true }
```

`database_count` 为 `1` 就说明**运行时只看到 1 个库**（面板里没配齐）。端点只回显 host，**不暴露用户名和密码**。

#### 备库的建表（已自动化）

新开的 Neon 备库是**空的**，一张表都没有，直接同步会失败。`scripts/db-sync.mjs` 现在会**自动**把 `migrations/*.sql` 应用过去建表，再开始搬数据 —— 不需要你手工把备库临时设成主库去自举。

如果备库始终建不出表（连不上、迁移漂移），同步步骤会**直接让 CI 变红**，而不是静默跳过 —— 以前那种「构建全绿、备库全空」的情况不会再发生。

```bash
npm run db:sync            # 主库 → 全部备库：自动建表 + 全量同步
npm run db:sync:verify     # 只校验备库 schema 是否齐备，不搬数据
DB_SYNC_SKIP=audit_logs npm run db:sync   # 跳过指定表
```

CI 里这三步的顺序是「**先同步、后部署**」，避免出现「新代码 + 旧数据」的窗口。数据搬运的偶发错误不阻断部署（备库是安全网）；但**结构性失败（连不上/建不出表/缺表）会让 CI 失败**，因为那意味着这个备库根本没被用上。

## 缓存：构建时清空，每小时刷新

KV 在这里**纯粹是缓存** —— 唯一的真相在 Neon 里。所以「缓存键」是可以随时丢掉的，而**每次部署都从零开始是必要的**：缓存键的语义契约会随版本变化，但键名不变，于是「上一版写的值」在新版读出来就是错的。本项目踩过这个坑（前端把站点配置缓存在 localStorage 旧键里，脏值被永久缓存，每次打开都崩），所以每次构建都清一遍。

### 清空 + 重填（构建期，`kv:purge`）

`npm run deploy` 会自动跑 `scripts/kv-purge-refill.mjs`（在「KV 已就绪」之后、「发布」之前）：

```bash
npm run kv:purge        # 清空 + 交回填给 Worker
npm run kv:purge:dry    # 只看会清哪些 namespace / 前缀，不动手
```

**清哪些、不清哪些，由 `src/lib/cacheRegistry.ts` 这张清单决定**（唯一真相，脚本只是把它翻译成命令）：

| 缓存类 | 角色 | 键前缀 | 清理 |
|---|---|---|---|
| 站点设置 | site | `settings:` | ✅ |
| 用户行 | session | `user:` | ✅ |
| 验证码 | session | `captcha:` | ✅ |
| 一次性会话状态（吊销/2FA/OIDC state/OAuth code/passkey） | session | `session:` | ✅ |
| 上传 / 打包 / WebDAV 锁 / WOPI | upload | `upload` | ✅ |
| 外部凭据缓存（OneDrive token / OIDC discovery） | cred | （整块） | ✅ |
| **自举 / 迁移标记** | **flag** | `bootstrap:` | ❌ **永不清理** |

> **`flag` 角色永不清理，这是整套机制里最重要的一条。** 清掉 `bootstrap:done:v*` 会让 Worker 认为站点还没自举，于是每次冷启动重放 `provision()` + `ensureSettings()`（两次全表扫描）——免费档 Neon 直接打限流，而症状是「站点变慢」不是「报错」，极难定位。这条不变量由 `npm run test:cache-purge` 的断言固化。

**为什么清空放在构建脚本里、不放 Worker 里**：KV 的绑定 API **没有批量删**（`delete(key)` 只收一个键名，与 Durable Object 的 `delete(keys[])` 不同）。在 Worker 里清空 = `list` 翻页 + 逐键 `delete`，而每个键的删除都是一个 subrequest —— 免费档总共 50 个，清 200 个键就把预算烧光。CLI 走 Cloudflare HTTP API 没这个限制（`kv bulk delete` 一次最多 10000 个键）。

**回填**不在这步做：构建脚本没有 Worker 的 env 绑定（拿不到库连接）。交给 Worker —— 部署后第一次请求重建站点设置缓存，其余按需填充。

### 每小时刷新（Cron，`0 * * * *`）

`src/index.ts` 的 `scheduled()` 每小时整点做两件事：

1. **缓存刷新** —— 把站点设置回源重写一遍（覆盖写，**零 list / 零 delete**，开销恒定，不随缓存键数增长），保证内容不会因为「某条写路径漏了失效」而长期陈旧；
2. 回收站到期清理（对应原版的 `trash_collector`）。

刷新用的是「**先算出新值、再覆盖旧值**」，而不是「先删旧值、再回源」。后者有两个毛病：删掉之后到新值写回之间有**空窗**（并发请求全部回源打库），而且如果回源失败，一份本来可用的缓存就白白丢了。覆盖写没有这两个问题。

### 怎么确认在生效

```bash
curl https://你的域名/api/v4/site/cache-status
curl "https://你的域名/api/v4/site/cache-status?refresh=1"   # 顺手刷一次
```

返回每类缓存的**键数**与清理名单（只给条数，不含任何业务数据）。`keys` 为 `-1` 表示该角色未绑定。

## 架构

```
                    ┌──────────────────────────────────────────┐
  浏览器 ──────────▶│  Cloudflare Worker（本仓库）              │
                    │  Hono 路由 → 服务层 → 仓储层               │
                    └───┬──────────┬──────────┬────────────────┘
                        │          │          │
              Neon (HTTP)│   KV×N   │    R2 绑定│   Microsoft Graph
                        ▼          ▼          ▼
                  ┌─────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐
                  │ 主库     │ │ 5 类角色│ │ 文件本体 │ │ OneDrive │
                  │ 唯一可写 │ │ 各自缓存│ │         │ │  直传    │
                  └────┬────┘ └────────┘ └─────────┘ └──────────┘
                       │ 构建期全量 COPY 同步（只读，冷备）
                       ▼
                  ┌─────────────────────────────┐
                  │ 备库 ×1..4（DATABASE_URL_2..5）│
                  │ 主库挂了可临时接管（DB_FAILOVER）│
                  └─────────────────────────────┘
```

关键设计取舍：

- **HTTP 驱动的 Postgres，没有事务。** 用 `@neondatabase/serverless`，每条查询一个 HTTP 请求。上游用事务包裹的多步操作，这里改成「先做不可逆的、后做可逆的」，失败靠幂等重试兜底。
- **主库单写、备库只读。** 备库每次构建被全量覆盖，因此不接常规流量；要真实双活得用 Neon 自身的复制能力，不在本项目的机制范围内（详见上方「多个 KV / 多个数据库」）。
- **KV 按角色分工而非哈希分片。** 调大 `KV_COUNT` 不会让已有缓存失效，同一份键始终落在同一个 namespace。
- **位集用 `bytea`。** 权限位集与上游 `boolset.BooleanSet` 的 base64 序列化完全一致（含 LSB-first 位序），否则权限会整片错位。
- **回收站语义照抄上游。** 删除 = 文件行改名随机 UUID + 真实路径写进元数据；每小时 Cron 清理到期项。
- **HashID / JWT / 错误码与上游同算法**，前端零适配。

---

以下内容面向想深入了解或自己改代码的人。

## 它是什么 / 不是什么

| | |
|---|---|
| ✅ 是 | 一个**独立的 Cloudreve v4 后端实现**，API 与官方前端兼容，可部署到 Cloudflare 免费/付费套餐 |
| ✅ 是 | 单节点、无状态（状态都在 Neon / KV / R2 里），可以水平扩容 |
| ❌ 不是 | 上游仓库的分支或补丁，不共用任何代码 |
| ❌ 不是 | 上游数据库的直读实现 —— 用的是自建的等价 schema（见 `migrations/0001_init.sql`） |
| ❌ 不是 | 完整功能对等。**未实现的功能见下节**，请先读完再决定是否适用 |

Workers 的 isolate 模型不支持长驻进程、原生 socket、任意文件系统访问；上游后端重度依赖 ent ORM、本地缓存、队列任务与多节点 RPC。可行的路线只有重写，这也是本仓库存在的原因。

## 功能实现状态

判定口径是**官方前端会不会调到**：前端 `src/api/api.ts` 里每个 `send()` 调用就是一条契约。官方前端共 127 条契约，本仓库全部有端点响应（无 404）；少数能力边缘版明确不支持，见下表，不会静默返回错误数据。

复算：`python scripts/scan-frontend-contract.py <官方前端>/src/api src/routes .`

### 已实现的主要功能

文件管理与回收站、分享（密码 / 有效期 / 付费分享：访客支付积分才能下载）、上传下载（R2 + OneDrive，含分片与直传回调）、文件版本自动裁剪与版本切换、两步验证（TOTP）、Passkey/WebAuthn（ES256/RS256/Ed25519）、WebDAV（账号 CRUD + 完整协议服务端）、OAuth2 授权码流程（PKCE + userinfo + 桌面客户端自动注册）、打包下载（`/workflow/archive` 入库 + `/file/archive/:id/archive.zip` 流式直链下载）、解压与压缩包在线浏览（含 GBK 等非 UTF-8 文件名）、从存储策略导入（R2/S3 兼容/OneDrive）、远程下载（HTTP 直链 + URL 列表文件导入）、事件推送（SSE）、WOPI / 在线预览会话、验证码（内置 SVG + Turnstile / reCAPTCHA / Cap）、下载限速（代理下载按用户组 `speed_limit` 生效）、全文检索（Meilisearch + Tika，与原版同构）、管理后台（用户/组/策略/文件/实体/分享/节点/OAuth 应用）、SMTP 邮件（激活/找回/测试发信 + 自定义模板）、支付体系（订单 / 礼品卡 / 易支付 Epay 协议 / /shop 商店页，支持积分、容量包、用户组套餐等商品）、增值服务（VAS）设置、事件（Events）审计系统（39 类事件埋点 + 审计日志查看器）、图片缩略图（Cloudflare Image Resizing 实时缩放）、老版 v2 密码（md5:hash:salt）兼容登录与惰性升级、第三方登录（通用 OIDC 授权码流程：任意标准 IdP 如 Logto / Keycloak / Auth0 / Authentik / QQ 互联 OIDC 模式可接入本站）、注册邮箱策略（邮箱域白/黑名单 + 禁用子地址 `+` 邮箱）。

### 未实现（明确不支持的能力）

| 功能 | 位置 | 说明 |
|---|---|---|
| 其它驱动上传回调 | `/callback/:driver/*` | 只实现 OneDrive 回调；R2/S3 等直传协议不走回调，此端点保留但返回 40019 |
| 多节点分派 | `/admin/node/*` | 节点 CRUD 与连通性测试可用，但任务不分派到节点（请求内同步跑完） |

> 图片缩略图已由 Cloudflare Image Resizing 实时生成（见上「已实现的主要功能」），需站点所在 zone 启用 Image Resizing 付费附加项；未启用时回退为原图（浏览器按 CSS 缩放）。视频 / Office 文档缩略图仍依赖驱动原生能力（OneDrive 可用）。v2 老密码（`md5:hash:salt`）已支持兼容登录并惰性升级为 v4 安全格式，无需手动迁移。

### 已实现、但与原版口径不同的几处

- **workflow 任务在请求内同步跑完**：原版投后台 goroutine 池慢慢跑，Workers 没有常驻进程。打包单次上限 200 MB，超限明确报错而不是建一个跑不完的任务。
- **全文检索未配置时回落文件名匹配**：Meilisearch/Tika 是原版就要求的独立部署项，没配也能用搜索，只是搜不到正文。
- **邮件的 `mail_keepalive` 不生效**：Workers 每次发信新建连接，字段留着只为兼容面板。
- **`SITE_URL` 初始为空**：部署后到面板改成真实地址，否则分享链接指向错误主机。

## 配置速查（详细步骤见 DEPLOY.md）

- **邮件**：管理后台 → 设置 → 邮件。Resend 填 `smtp.resend.com:465`，用户名 `resend`，密码是 API Key。⚠️ 端口 25 被 Workers 禁止，只能用 465 或 587。
- **全文检索**：管理后台 → 文件系统 → 全文检索。填 Meilisearch 和 Tika 的地址，配好点「重建索引」；新上传的文件自动进索引。
- **R2 直链**：给桶配自定义域后，加变量 `R2_PUBLIC_BASE`，直链就不走 Worker 中转。
- **OneDrive**：策略里填 Azure 应用的 client_id / client_secret / refresh_token，server 域名决定走全球版还是世纪互联。

## 有意为之的偏离（写在明处）

1. **没有数据库事务。** 原因见架构一节。副作用是极端并发下可能出现半完成状态，设计上尽量把不可逆操作排在最后。
2. **第一个注册的用户自动进管理员组。** 原版靠 seed 脚本建管理员，云端部署没有这个机会。
3. **新增了一个端点** `POST /api/v4/share/save/:id`（转存到自己的网盘）。原版官方前端的「保存到我的网盘」走符号目录，这条路径也已实现且行为对齐（符号目录不可遍历）；WebDAV 下看不到符号目录内容，需要转存请用新增端点。
4. **版本管理只做自动裁剪。** `/file/version` 一族端点（查看/切回/手动删历史版本）返回 40019 —— 历史版本存着但看不到。
5. **CORS 默认关闭**，与上游一致；前端与 Worker 同源时不需要开。
6. **直链访问计数**与上游一致，但没做去重。

## 对齐方式（怎么保证不出错）

原则是**任何契约都回源码核对，不凭印象**：

- 错误码：`pkg/serializer/error.go` → `src/lib/errors.ts`
- 路由：`routers/router.go` → `src/routes/*.ts`
- 响应字段：`service/*/response.go` 的 JSON tag → `src/services/*.ts` 的 `*Response` 接口
- 设置键：`inventory/setting.go` → `src/settings/defaults.ts`（键名一个都不能编，前端会直接读）
- schema：`ent/schema/*.go` → `migrations/0001_init.sql`
- 权限：`inventory/types/types.go` 的 `GroupPermission` → `src/lib/boolset.ts`

覆盖度用 `scripts/scan-frontend-contract.py` 自动比对官方前端与后端路由，方法论见 [docs/FRONTEND-CONTRACT-COVERAGE.md](./docs/FRONTEND-CONTRACT-COVERAGE.md)。

## 目录结构

```
src/
  index.ts              Worker 入口：中间件、路由挂载、/s 与 /f、scheduled()
  env.ts                绑定与变量类型
  middleware/app.ts     请求上下文（设置 + 当前用户 + 仓储）
  lib/                  errors / boolset / response / hashid / jwt / sign /
                        crypto / sysmeta / totp / webauthn / zip
  db/
    provision.ts        冷启动自动建表 + 播种系统数据（首次请求时执行）
    repo.ts             各表仓储（SQL 都在这）
    types.ts            行类型
  services/             fs / share / user / upload / download / oauth /
                        passkey / search / workflow / mail / smtp
  storage/              r2 / onedrive 驱动
  settings/             defaults（对齐上游）+ provider（KV 缓存）
  routes/               site / session / user / file / share / admin /
                        admin-content / devices / dav / workflow / callback
migrations/*.sql        建表脚本（首次请求自动执行）
scripts/                deploy / fetch-frontend（自动拉取并构建官方前端）/ migrate / seed / 验证脚本
frontend/               官方前端构建产物 —— 不入库，部署时自动生成（见 scripts/fetch-frontend.mjs）
```

## 从源码构建与部署（构建文档）

想自己改代码或自己构建发布，照这一节走。全程只需要 Node.js 和 npm。

### 前置要求

| 工具 | 版本 | 用途 |
|---|---|---|
| [Node.js](https://nodejs.org/) | **20 或 22**（别用更老的） | 构建、类型检查、跑部署脚本 |
| npm | 随 Node 附带 | 装依赖 |
| Git | 任意 | 拉源码 |
| Neon Postgres | — | 元数据库，[neon.tech](https://neon.tech) 免费注册，复制 **Connection string**（`postgresql://...`） |

不需要提前装 wrangler 全局包（仓库带本地版本），也不需要手动改 `wrangler.toml` —— KV / R2 的 ID 由部署脚本自动创建并回填。

### 1. 拉源码、装依赖

```bash
git clone https://github.com/LegspCpd/Cloudreve-Worker.git
cd Cloudreve-Worker
npm install
```

### 2. 本地开发（可选）

把机密写进 `.dev.vars`（参考 `.dev.vars.example`，已被 `.gitignore` 排除）：

```ini
DATABASE_URL=postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require
```

```bash
npm run dev           # 起 wrangler dev 本地服务
```

首次请求会自动建表（Neon 上执行 `migrations/*.sql`）并播种系统数据，不需要手动跑迁移。要手动控制时才用：

```bash
npm run db:migrate    # 手动执行建表脚本
npm run db:seed       # 手动播种默认用户组/OAuth 客户端等
```

### 3. 类型检查与构建

```bash
npm run typecheck     # tsc --noEmit，改完代码先跑这个
npm run build         # 拉官方前端源码并构建 → wrangler 打包 → 产物在 dist/
```

`npm run build` 会自动从上游 `cloudreve/frontend`（固定提交）下载前端源码、Vite 构建、叠加本仓库 `frontend-patches/` 覆盖层，然后 dry-run 打包 —— **官方前端不需要你手动准备**。只想验证能构建不想产出，`npm run build` 本身就是 dry-run，不会真的发布。

### 4. 部署到 Cloudflare

```bash
npx wrangler login    # 浏览器授权一次
npm run deploy
```

`npm run deploy`（即 `scripts/deploy.mjs`）按顺序做四件事：

1. 检查 KV namespace —— 账号里已有同名（`cloudreve-worker-KV` 或 `KV`）就直接复用，没有才创建，真实 ID 自动回填 `wrangler.toml`；
2. 检查 R2 bucket —— 同上，已存在就复用；
3. 重新拉取并构建官方前端，`wrangler deploy` 发布；
4. 环境变量里有 `DATABASE_URL` 时自动写入 Worker 运行时 Secret。

`SITE_URL` / `FRONTEND_URL` 环境变量如果设置了，部署时以 `--var` 覆盖 `wrangler.toml` 里的值。部署完打开 Worker 地址，**第一个注册的账号自动是管理员**，再到管理后台把站点 URL 改成真实地址。

### 5. 更新到新版本

```bash
git pull
npm install
npm run deploy
```

### 6. 让 GitHub 自己构建部署（Workers Builds）

仓库接 Cloudflare Workers Builds（Workers & Pages → Create → 选仓库）时只填两格：

| 框 | 命令 |
|---|---|
| **构建命令** | `npm install` |
| **部署命令** | `npm run deploy` |

环境变量（项目设置 → 环境变量）里加 `DATABASE_URL`，可选 `SITE_URL`。每次 push 到 main 自动构建发布。仓库自带的 CI 见下节「CI 检查」。

## 开发速查

```bash
npm run typecheck     # tsc --noEmit
npm run build         # 拉前端 + wrangler dry-run 打包（产物 dist/，不发布）
npm run dev           # 本地 wrangler dev
npm run deploy        # 真实部署（自动 KV/R2/Secret）
npm run kv:setup      # 只重写 wrangler.toml 的 KV 段（按 KV_COUNT）
npm run db:sync       # 主库 → 备库全量同步
```

测试（`npm run test:multidb` 会依次跑全部四项）：

```bash
npm run test:kv-router     # 多 KV 角色路由（离线）
npm run test:db-failover   # 主备切换路由决策（离线）
npm run test:copy:setup    # 建 COPY 测试用的本机库（需本机 PostgreSQL）
npm run test:copy          # COPY 全量同步真机往返（需本机 PostgreSQL）
```

`test:copy` 连本机 PostgreSQL 真跑一遍 `COPY TO STDOUT → FROM STDIN`，逐列对拍两库内容。这一项**不能省**：它曾抓出「假设 COPY 输出表头 → 每张表静默丢掉第一行」的真实事故，靠 mock 永远发现不了。前两项是纯离线的，已接入 CI。

本地调试把机密写进 `.dev.vars`（已被 `.gitignore` 排除），参考 `.dev.vars.example`。多库/多 KV 的本地配置也写在这里：

```bash
DATABASE_URL="postgresql://..."
DATABASE_URL_2="postgresql://..."   # 可选备库
KV_COUNT=3                           # 可选，1–5
```

## CI 检查

仓库自带 GitHub Actions（`.github/workflows/ci.yml`），两级检查：

1. **构建 + dry-run**（每次 push / PR 自动跑）：类型检查 → KV 装配（校验 `KV_COUNT` 上限）→ 多 KV / 主备路由回归测试 → `wrangler deploy --dry-run`，代码或 `wrangler.toml` 配置有错会直接标红。
2. **真实部署检查**（可选）：在仓库 Settings → Secrets and variables → Actions 配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`（可选再配 `DATABASE_URL`、`DATABASE_URL_2..5`、`KV_COUNT`、`DB_FAILOVER`），push 到 main 时会**先做一次主库→备库全量同步，再**真实部署（同样自动复用/创建 KV、R2）。不配 secrets 则自动跳过，不影响检查通过。

## 许可

GPL-3.0，与上游 Cloudreve 一致。详见 `LICENSE`。
