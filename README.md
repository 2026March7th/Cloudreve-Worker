# Cloudreve-Worker

把 Cloudreve v4 的后端**重写**成可跑在 Cloudflare Workers 上的 TypeScript 实现
（不是编译、不是移植 —— Go 跑不了 Workers）。

- 前端 100% 使用[官方前端](https://github.com/cloudreve/frontend)，本项目只做后端
- 元数据存 Neon Postgres，文件本体存 R2 或 OneDrive，会话/缓存用 KV
- 与上游 v4.14.0 的接口契约、错误码、字段名逐条对齐，官方前端不需要任何修改
- 沿用上游的 GPL-3.0 许可，上游版权归 Cloudreve 项目及其贡献者所有

---

## 一键部署

全程手机浏览器可完成，不需要本机装任何东西：

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

输出目录留空。`npm run deploy` 会**自动创建 KV 和 R2 并回填 ID**，不需要改 `wrangler.toml`。

然后在项目的**设置 → 环境变量**里添加 `DATABASE_URL`（第 1 步的连接串），保存后重新部署 —— 部署脚本会自动把它写入 Worker 的运行时 Secret，不用再去面板手动加。`SITE_URL` 同样加在这个环境变量里即可。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon 连接串。加在部署项目的环境变量里，`npm run deploy` 会自动写成运行时 Secret；也可部署后在 Worker 的「变量和机密」里手动加 |
| `SITE_URL` | 建议 | 站点对外地址（Worker 地址），加在部署项目的环境变量里即可自动生效 |
| `JWT_SECRET` | 可选 | 令牌签名密钥（32 位以上随机串）。不设会自动生成并入库 |
| `FRONTEND_URL` | 可选 | 官方前端单独部署在别处时才填，Worker 会把非 API 请求反代过去 |
| `LOG_LEVEL` | 可选 | `debug` / `info` / `warn` / `error`，默认 `info` |

邮件、全文检索（Meilisearch + Tika）、存储策略等全部在**管理后台**配置，不占环境变量。详见 [DEPLOY.md](./DEPLOY.md)。

## 架构

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

关键设计取舍：

- **HTTP 驱动的 Postgres，没有事务。** 用 `@neondatabase/serverless`，每条查询一个 HTTP 请求。上游用事务包裹的多步操作，这里改成「先做不可逆的、后做可逆的」，失败靠幂等重试兜底。
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

判定口径是**官方前端会不会调到**：前端 `src/api/api.ts` 里每个 `send()` 调用就是一条契约。按 127 条前端契约统计：

```
已实现 120 条    桩 7 条（返回 40019）    缺失 0 条
```

复算：`python scripts/scan-frontend-contract.py <官方前端>/src/api src/routes .`

### 已实现的主要功能

文件管理与回收站、分享（密码/有效期/付费位）、上传下载（R2 + OneDrive，含分片与直传回调）、文件版本自动裁剪、两步验证（TOTP）、Passkey/WebAuthn（ES256/RS256/Ed25519）、WebDAV（账号 CRUD + 完整协议服务端）、OAuth2 授权码流程（PKCE + userinfo）、打包下载（流式 ZIP 入库）、远程下载（HTTP 直链）、全文检索（Meilisearch + Tika，与原版同构）、管理后台（用户/组/策略/文件/实体/分享/节点/OAuth 应用）、SMTP 邮件（激活/找回/测试发信）。

### 未实现（7 个桩 + 几项明确说明）

| 功能 | 端点 | 说明 |
|---|---|---|
| 解压 / 浏览压缩包 | `POST /workflow/decompress`、`GET /file/archive` | 需要一个 ZIP 读取器（写入端已实现）；桩返回 40019 |
| 从存储策略导入 | `POST /workflow/import` | 桩 |
| 事件推送（SSE） | `GET /file/events` | 桩 |
| WOPI / 在线预览会话 | `/file/wopi`、`/file/viewerSession` | 桩 |
| 其它驱动上传回调 | `/callback/*`（remote/oss/cos/s3 等） | 只实现了 OneDrive 回调，其余桩 |
| 缩略图 | `GET /file/thumb` | 只透传存储驱动的缩略图能力，不做本地转码 |
| 限速 | — | 字段被读取但不生效 |
| 付费分享 | — | 没有支付体系，相关错误码保留但不会有路径返回 |
| 多节点分派 | `/admin/node/*` | 节点 CRUD 与连通性测试可用，但任务不分派到节点（请求内同步跑完） |

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
scripts/                migrate / seed / 验证脚本
```

## 开发

```bash
npm run typecheck     # tsc --noEmit
npm run build         # wrangler deploy --dry-run --outdir=dist
npm run dev           # 本地 wrangler dev
```

本地调试把机密写进 `.dev.vars`（已被 `.gitignore` 排除），参考 `.dev.vars.example`。

## 许可

GPL-3.0，与上游 Cloudreve 一致。详见 `LICENSE`。
