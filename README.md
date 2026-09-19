# Cloudreve Edge

把 Cloudreve v4 的后端**重写**成一套可跑在 Cloudflare Workers 上的 TypeScript 实现
（不是编译、不是移植二进制 —— Go 跑不了 Workers）。

- **只做后端。** 前端 100% 使用[官方前端](https://github.com/cloudreve/frontend)，
  本项目不含任何自研前端代码。
- **数据面**：Neon Postgres（元数据）+ Cloudflare KV（会话/上传会话状态/设置缓存）
  + Cloudflare R2 或 OneDrive（文件本体）。
- **对象存储**：内置 `r2` 策略类型，直接走 Worker 的 R2 绑定；另有完整的 OneDrive
  （Microsoft Graph）驱动，含全球版与世纪互联两套 OAuth 端点。
- 与上游 v4.14.0 的接口契约、错误码、字段名逐条对齐（见下文「对齐方式」）。

> 本项目是 Cloudreve 的衍生作品，沿用上游的 **GPL-3.0** 许可（见 `LICENSE`）。
> 上游版权归 Cloudreve 项目及其贡献者所有。

---

## 1. 它是什么 / 不是什么

| | |
|---|---|
| ✅ 是 | 一个**独立的 Cloudreve v4 后端实现**，API 与官方前端兼容，可部署到 Cloudflare 免费/付费套餐 |
| ✅ 是 | 单节点、无状态（状态都在 Neon / KV / R2 里），可以水平扩容 |
| ❌ 不是 | 上游仓库的分支或补丁，不共用任何代码 |
| ❌ 不是 | 上游数据库的直读实现 —— 用的是自建的等价 schema（见 `migrations/0001_init.sql`） |
| ❌ 不是 | 完整功能对等。**未实现的功能见第 4 节**，请先读完再决定是否适用 |

### 为什么不是「把 Go 编译成 WASM」

Workers 的 isolate 模型不支持长驻进程、原生 socket、任意文件系统访问；Cloudreve 后端
重度依赖 ent ORM、本地缓存、队列任务与多节点 RPC。可行的路线只有重写。

---

## 2. 架构

```
                    ┌──────────────────────────────────────────┐
  浏览器 ──────────▶│  Cloudflare Worker（本仓库）              │
                    │  Hono 路由 → 服务层 → 仓储层               │
                    └───┬──────────┬──────────┬────────────────┘
                        │          │          │
              Neon (HTTP)│    KV    │    R2 绑定│   Microsoft Graph
                        ▼          ▼          ▼
                  ┌─────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐
                  │ 元数据   │ │ 会话   │ │ 文件本体 │ │ OneDrive │
                  │ 10 张表  │ │ 上传态 │ │         │ │  直传    │
                  └─────────┘ │ 设缓存 │ └─────────┘ └──────────┘
                              └────────┘
```

### 关键设计取舍

- **HTTP 驱动的 Postgres。** 用 `@neondatabase/serverless`，每条查询一个 HTTP 请求。
  **没有事务** —— 上游用 `ent` 事务包裹的多步操作，这里改成「先做不可逆的、后做可逆的」
  的顺序，失败时靠幂等重试兜底。这是本项目最大的语义偏离，见第 5 节。
- **位集用 `bytea`。** `groups.permissions`、`dav_accounts.options` 等在原版是
  `boolset.BooleanSet`（Go 的 `[]byte`），JSON 序列化成 base64。这里保持完全一致，
  包括 **LSB-first** 的位序，否则权限会整片错位。
- **软删除的回收站语义照抄上游。** 删除 = 把 `files.name` 改成随机 UUID
  + `file_children` 置 NULL，真实路径写进 `sys:restore_uri` 元数据；
  列表显示名取自该元数据的最后一段，恢复时靠它定位原目录。自动清理依据
  `sys:expected_collect_time`，挂在 Worker 的 `scheduled()` 上（对应上游的
  `trash_collector` 队列任务）。
- **HashID 与 JWT 与上游同算法。** hashid salt、令牌前缀（`Bearer ` / `Bearer Cr `）、
  scope 语义、`code` 错误码表全部逐字对齐，前端不需要任何适配。

---

## 3. 对齐方式（怎么保证不出错）

这个项目的原则是**任何契约都回源码核对，不凭印象**。落地方式：

- 错误码：`pkg/serializer/error.go` → `src/lib/errors.ts`（逐条抄，含 HTTP 复用码 401/403/404）
- 路由：`routers/router.go` → `src/routes/*.ts`（含各端点的鉴权中间件要求）
- 响应字段：`service/explorer/response.go` 等 → `src/services/*.ts` 的 `*Response` 接口，
  JSON tag 就是 TS 字段名
- 设置键：`inventory/setting.go` 的 `DefaultSettings` → `src/settings/defaults.ts`
  （**键名一个都不能编**，前端会直接读）
- schema：`ent/schema/*.go` → `migrations/0001_init.sql`（含 `StorageKey` 改写，
  例如 `entities.props` 在库里叫 `recycle_options`）
- 权限：`inventory/types/types.go` 的 `GroupPermission` → `src/lib/boolset.ts`
- 导航/权限判定：`pkg/filemanager/fs/dbfs/*_navigator.go` → `src/services/fs.ts` 的
  `resolveMy` / `resolveTrash` / `resolveShare` / `resolveSharedWithMe`

---

## 4. 未实现的功能

这些端点**都在位**，但统一返回 `code: 40019`（`CodeFeatureNotEnabled`）并附一句说明，
不会让前端拿到 404 后误判成「后端挂了」：

| 功能 | 端点 | 状态 |
|---|---|---|
| 打包下载（流式 zip） | `GET/POST /api/v4/file/archive*` | 返回 40019。边缘版没有常驻进程，无法边压缩边流式输出 |
| 全文搜索（FTS） | `GET /api/v4/file/search` | 返回 40019。未接 Meilisearch |
| 事件推送（SSE） | `GET /api/v4/file/events` | 返回 40019 |
| WOPI / 在线预览会话 | `/api/v4/file/wopi*`、`PUT /api/v4/file/viewerSession` | 返回 40019 |
| 文件版本管理 | `POST /api/v4/file/version/current`、`DELETE /api/v4/file/version` | 返回 40019。**旧版本实体仍会保留**，只是没有切换/删除入口 |
| 上传回调 | `POST /api/v4/callback/onedrive/:sid/:key` | **已实现**。OneDrive 是客户端直传，字节不经过 Worker，必须靠这个回调完成「实体转正 + 容量记账」 |
| 上传回调（其它驱动） | `/api/v4/callback/*` | 返回 40019。remote / oss / upyun / cos / s3 / ks3 / obs / qiniu 都不实现 |
| WebDAV | `/dav` | **路由不存在**（404）。`dav_accounts` 表也未建 |
| 两步验证（TOTP） | `POST /api/v4/session/token/2fa` | 返回 40019。**已设置 `two_factor_secret` 的账号将无法登录** |
| Passkey / WebAuthn | `POST /api/v4/session/authn/*` | 返回 40019。`passkeys` 表未建 |
| OAuth 应用（Client/Grant） | `/api/v4/session/oauth/*` | 路由不存在。`oauth_clients` / `oauth_grants` 表未建 |
| 邮件（激活 / 找回密码） | `/api/v4/user/reset`、`/api/v4/user/activate/:id` | 返回 40019 |
| 多节点集群 / 从节点 | `/api/v4/slave/*` | 路由不存在。`nodes` 表未建 |
| 离线下载 / 远程下载 | — | 未实现 |
| 缩略图生成 | `GET /api/v4/file/thumb` | 端点可用，但只**透传**存储驱动的缩略图能力；边缘版不做本地转码 |
| 限速 | — | 未实现。`speed_limit`（组）与 `speed`（直链）字段被读取但**不生效**，URL 里的 `/speed/` 段仅作协议占位 |
| 付费分享 | — | 完全没有。`CodePurchaseRequired` 等四个码保留定义但不会有路径返回 |
| 文件锁 | `DELETE /api/v4/file/lock` | 直接返回成功（无锁实现） |

### 前端会碰到的具体影响

- 官方前端的「打包下载」按钮会收到 40019，需要隐藏或改造。
- 官方前端的「版本历史」面板拿不到数据。
- 开了两步验证的账号登录会被拒（40019，提示信息为 "Two-factor authentication is not
  supported in the edge build"）。

---

## 5. 有意为之的偏离（写在明处）

1. **没有数据库事务。** 原因见第 2 节「关键设计取舍」。副作用是极端并发下可能出现
   半完成状态（例如实体已写、文件行未更新）。设计上尽量把「不可逆操作」排在最后。
2. **新增了一个端点** `POST /api/v4/share/save/:id`（转存到自己的网盘，直接复制实体）。
   原版没有独立转存端点，官方前端的「保存到我的网盘」走的是另一条路：
   `POST /file/create` 建一个**符号目录**（`files.is_symbolic = true`），
   metadata 带 `sys:shared_redirect = cloudreve://<shareHashid>@share`。
   这条路径在边缘版也已实现（见 `src/services/fs.ts` 的 `create`）：
   - create 时检测到该 metadata 就置 `is_symbolic`（对齐 `manager/operation.go:116-135`）；
   - 符号目录**不可遍历**，`cloudreve://my/<符号目录>/...` 与直接列它都返回
     403 `Symbolic folder cannot be walked into`（对齐 `dbfs/navigator.go:179-183, 241-243`）。
   - ⚠️ 上游还实现了 `SharedAddressTranslation`（把符号目录映射到真实分享地址），
     但**只有 WebDAV 调用它**，普通 API 不调用。边缘版不实现 WebDAV，因此也没实现
     地址翻译 —— 官方前端能否自行跳转**未实测**。如果「保存到我的网盘」在你的环境下
     不工作，就用上面那个新增端点代替。
3. **`groups.permissions` 的 `authn_enabled` 默认值。** 上游 `DefaultSettings`
   里是 `"1"`，本项目默认 `"0"` —— 因为不实现 Passkey，置 1 只会让前端多显示一个
   用不了的功能。
4. **CORS 默认关闭。** 与上游一致：只有配置了 `CORS_ALLOW_ORIGINS` 才回 `ACAO` 头。
   官方前端与 Worker 同源部署时不需要开。
5. **版本管理只做自动裁剪，没做手动操作。** 覆盖写会新增版本实体，之后按用户的
   版本保留策略裁剪（`version_retention` / `version_retention_max` / `version_retention_ext`，
   默认保留 10 版，对齐上游 `CapEntities`）。被裁掉的实体会连同物理对象一起删除，
   用户容量同步回冲。但 `/file/version` 一族端点（查看历史版本、切回旧版、手动删版）
   未实现，返回 40019 —— 也就是说历史版本**存着但看不到**。
6. **直链访问计数。** `GET /f/:id/:name` 会 `downloads += 1`，与上游一致；
   但边缘版不做 `UniqueRedirectDirectLink` 去重。

---

## 6. 快速开始

完整步骤见 **[DEPLOY.md](./DEPLOY.md)**。最短路径：

```bash
npm install

# 1. 建资源
npx wrangler kv namespace create KV          # 把返回的 id 填进 wrangler.toml
npx wrangler r2 bucket create cloudreve-edge

# 2. 配机密（不要写进 wrangler.toml）
npx wrangler secret put DATABASE_URL         # Neon 连接串

# 3. 建表 + 初始化（本地跑，用同一个 DATABASE_URL）
DATABASE_URL="postgresql://..." npm run db:migrate
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' DATABASE_URL="postgresql://..." npm run db:seed

# 4. 发布
npm run deploy
```

接入官方前端有两种方式（**推荐 A**），见 DEPLOY.md 第 5 节。

---

## 7. 目录结构

```
src/
  index.ts              Worker 入口：中间件、路由挂载、/s 与 /f、scheduled()
  env.ts                绑定与变量类型
  middleware/app.ts     请求上下文（设置 + 当前用户 + 仓储）
  lib/
    errors.ts           错误码表（对齐 pkg/serializer/error.go）
    boolset.ts          权限位集 + GroupPermission 位号
    response.ts         统一信封 {code, data, msg}
    hashid.ts           HashID 编解码 [id, type]
    jwt.ts              HS256 令牌
    sign.ts             HMAC URL 签名（Cr 前缀）
    crypto.ts           sha256 / base64 / 随机串
    sysmeta.ts          sys:* 元数据键
  db/
    index.ts            Neon 连接
    repo.ts             各表仓储（SQL 都在这）
    types.ts            行类型（BIGINT 已归一化成 number）
  services/
    context.ts          AppContext：权限、容量、策略解析
    fs.ts               文件系统（四种 navigator 合并实现）
    share.ts            分享
    share-rules.ts      分享有效性判定（fs 与 share 共用）
    user.ts / upload.ts / download.ts / uri.ts / savepath.ts
  storage/
    index.ts            驱动工厂
    r2.ts / onedrive.ts / types.ts
  settings/
    defaults.ts         设置默认值（对齐 inventory/setting.go）
    provider.ts         读取 + KV 缓存 + 冷启动自举
  routes/
    site / session / user / file / share / admin
migrations/0001_init.sql
scripts/migrate.mjs    执行 migrations/*.sql
scripts/seed.mjs       三个系统用户组 + 默认策略 + 管理员
```

---

## 8. 开发

```bash
npm run typecheck     # tsc --noEmit
npm run build         # wrangler deploy --dry-run --outdir=dist
npm run dev           # 本地 wrangler dev
```

本地调试把机密写进 `.dev.vars`（已被 `.gitignore` 排除）：

```
DATABASE_URL="postgresql://..."
JWT_SECRET="..."
```

## 9. 许可

GPL-3.0，与上游 Cloudreve 一致。详见 `LICENSE`。
