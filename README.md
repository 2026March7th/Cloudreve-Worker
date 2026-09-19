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

## 4. 功能实现状态

判定口径是**官方前端会不会调到**：前端 `src/api/api.ts` 里每个 `send()` 调用就是一条契约，
逐条核对后，edge 侧分三态 —— **已实现 / 返回 40019 的桩 / 路由根本不存在（404）**。
桩是刻意保留的：不让前端拿到 404 后误判成「后端挂了」。

按 127 条前端契约统计：**已实现 101 条、桩 12 条、仍缺失 14 条**。
这个数字可以随时复算：

```bash
python scripts/scan-frontend-contract.py <官方前端>/src/api src/routes .
# 结果写进 _gap_result.txt
```

下表列**尚未实现**的部分；已经补上的（两步验证、搜索、打包、后台文件管理）见后面一节。

| 功能 | 端点 | 状态 |
|---|---|---|
| 浏览压缩包内容 | `GET /api/v4/file/archive` | 返回 40019。需要一个 ZIP **读取器**（含 inflate）；目前只实现了写入端 |
| ~~全文搜索（FTS）~~ | `GET /api/v4/file/search`、`POST /api/v4/workflow/rebuildFtsIndex` | **已实现，与原版同构**：Meilisearch 建索引 + Tika 抽正文（两者都是 HTTP 服务，Workers 直接调用）。索引、分块、distinct、高亮、AI 向量检索的参数逐项对齐上游。需要在管理面板「文件系统 → 全文检索」里配 endpoint；**未配置时自动回落文件名匹配**，不会出现开了没反应 |
| 事件推送（SSE） | `GET /api/v4/file/events` | 返回 40019 |
| WOPI / 在线预览会话 | `/api/v4/file/wopi`、`PUT /api/v4/file/viewerSession` | 返回 40019 |
| 上传回调（其它驱动） | `GET /api/v4/callback/*` | 返回 40019。remote / oss / upyun / cos / s3 / ks3 / obs / qiniu 都不实现 |
| ~~WebDAV~~ | `/api/v4/devices/dav` 共 4 条 + `/dav` 协议路由 | **已实现**。账号 CRUD + 完整协议服务端（OPTIONS/PROPFIND/GET/HEAD/PUT/MKCOL/DELETE/MOVE/COPY/PROPPATCH/LOCK/UNLOCK），Basic Auth 走 `dav_accounts`，只读账号禁写。`share://` 账号暂不挂载（返回 403），LOCK 是 KV 简化锁 |
| ~~两步验证（TOTP）~~ | `POST /api/v4/session/token/2fa` | **已实现**。RFC 6238 自实现（`src/lib/totp.ts`），与上游 `pquerna/otp` 参数逐项对齐 |
| ~~Passkey / WebAuthn~~ | `PUT/POST /api/v4/session/authn`、`GET/POST/DELETE /api/v4/user/authn` | **已实现**。WebAuthn 服务端零依赖自实现（`src/lib/webauthn.ts`）：CBOR 解码、COSE 公钥（ES256/RS256/Ed25519）、rpIdHash/origin/challenge/签名/计数器全量校验，用真实密钥对做过协议级测试。受站点设置 `authn_enabled`（默认开）门控 |
| ~~OAuth 应用授权~~ | `GET /api/v4/session/oauth/app/:id`、`POST /consent`、`POST /token`、`GET /userinfo`、`DELETE /grant/:id` | **已实现完整版**：授权码流程（redirect_uri 精确匹配、scope 子集校验、PKCE S256、授权码一次性）+ OIDC userinfo + 授权撤销，管理面板建的应用即可被第三方接入 |
| 节点管理 | `/api/v4/admin/node/*` | **增删改查与连通性测试已实现**。对真实上游从节点的 ping 测试是真 HTTP 请求 + 同款 HMAC 签名（`Authorization: Bearer Cr`），aria2 下载器测试走真实 JSON-RPC。但边缘版任务不分派到节点（请求内同步跑完），节点配置仅作为兼容与扩展预留 |
| ~~任务队列（打包 / 远程下载）~~ | `/api/v4/workflow/*` | **已实现，但口径不同**：原版投后台任务慢慢跑，边缘版**在请求内同步跑完**。打包把 zip 直接写进 `dst`；远程下载仅支持 HTTP(S) 直链。单次上限 200 MB，超限明确报错而不是建一个跑不完的任务。重建索引分批推进（每批 40 个，再点一次继续）。解压 / 导入仍是桩 |
| ~~后台文件 / 实体 / 分享管理~~ | `/api/v4/admin/file/*`、`/admin/entity/*`、`/admin/share/*` | **已实现**（`src/routes/admin-content.ts`），带筛选、排序与分页 |
| 缩略图生成 | `GET /api/v4/file/thumb` | 端点可用，但只**透传**存储驱动的缩略图能力；边缘版不做本地转码 |
| 限速 | — | 未实现。`speed_limit`（组）与 `speed`（直链）字段被读取但**不生效**，URL 里的 `/speed/` 段仅作协议占位 |
| 付费分享 | — | 完全没有。`CodePurchaseRequired` 等四个码保留定义但不会有路径返回 |
| 文件锁 | `DELETE /api/v4/file/lock` | 直接返回成功（无锁实现） |

### 已实现、但容易误判为「没实现」的几处

| 功能 | 端点 | 说明 |
|---|---|---|
| 两步验证（TOTP） | `GET /api/v4/user/setting/2fa`、`PATCH /api/v4/user/setting`、`POST /api/v4/session/token/2fa` | RFC 6238 自实现（`src/lib/totp.ts`），用官方测试向量验证过；密钥先暂存 KV `2fa_init_{uid}`，验码通过才写进账号 |
| 远程下载 | `POST /api/v4/workflow/download` | 仅 HTTP(S) 直链；种子 / 磁力需要 aria2 从节点，不支持 |
| 上传回调（OneDrive） | `POST /api/v4/callback/onedrive/:sid/:key` | OneDrive 是客户端直传，字节不经过 Worker，必须靠这个回调完成「实体转正 + 容量记账」 |
| 文件版本管理 | `POST /api/v4/file/version/current`、`DELETE /api/v4/file/version` | 含 `extended_info.entities` 的可见性规则 |
| 邮件（激活 / 找回密码 / 测试发信） | `POST /api/v4/user/reset`、`GET /api/v4/user/activate/:id`、`POST /api/v4/admin/tool/mail` | SMTP 协议自实现（`src/services/smtp.ts`），配置在管理后台，见第 5 节 |

### 前端会碰到的具体影响

- 官方前端的「解压」「浏览压缩包」「从存储策略导入」按钮会收到 40019。
- 其余管理后台页面（文件 / 实体 / 分享 / 用户 / 用户组 / 存储策略 / OAuth 应用 / 节点）都可用，节点页是空列表。

### 邮件怎么配：在管理后台，不在环境变量

进 **管理后台 → 设置 → 邮件**，填下面这几项。面板直接读写 `settings` 表，
键名与上游一致，**不需要任何环境变量**：

| 面板字段 | 设置键 | 说明 |
|---|---|---|
| 发件人名称 | `fromName` | |
| 发件人地址 | `fromAdress` | 上游的拼写错误，**别改**，改了面板就读不到 |
| SMTP 服务器 | `smtpHost` | 例：`smtp.resend.com` |
| SMTP 端口 | `smtpPort` | **只能用 465（SSL）或 587（STARTTLS）** |
| SMTP 用户名 | `smtpUser` | Resend 填 `resend` |
| SMTP 密码 | `smtpPass` | Resend 填 API Key（`re_` 开头） |
| 回复地址 | `replyTo` | |
| 强制 SSL | `smtpEncryption` | 打开则要求 TLS 必须成功，服务器不支持就直接报错 |
| 连接保活 | `mail_keepalive` | 边缘版每次发信新建连接，不做连接池，这一项**不生效**，留着只为兼容面板 |

填完点「发送测试邮件」—— 它会用**你当前表单里的值**（尚未保存也生效）真的发一封，
这是判断配置对不对最快的方式。

用 Resend 时这样填：

| 字段 | 值 |
|---|---|
| SMTP 服务器 | `smtp.resend.com` |
| SMTP 端口 | `465` |
| SMTP 用户名 | `resend` |
| SMTP 密码 | 你的 API Key（`re_` 开头） |

发件人地址必须是**已在 Resend 验证过的域名**下的邮箱，否则会被服务商拒收。

> ⚠️ **端口 25 用不了。** Cloudflare Workers 禁止出站连 25 端口（反滥用策略，官方文档
> 写得很明确：`Connections to port 25 are prohibited`）。上游的默认值恰好就是 25，
> 所以刚部署完什么都别改直接发信必然失败 —— 报错会直接告诉你改成 465 或 587。

「注册需邮件激活」由 `email_active` 控制（默认关闭）。打开后新注册用户状态是
`inactive`，要先点邮件里的链接才能登录；此时若 SMTP 没配好，注册会返回 40028。

### 全文检索怎么配

进 **管理后台 → 文件系统 → 全文检索**，打开总开关，然后填两个外部服务的地址：

| 面板字段 | 设置键 | 说明 |
|---|---|---|
| 总开关 | `fts_enabled` | 关闭时 `/file/search` 自动回落文件名匹配 |
| Meilisearch 地址 | `fts_meilisearch_endpoint` | 例：`http://meilisearch:7700`，末尾的 `/` 会自动去掉 |
| Meilisearch API Key | `fts_meilisearch_api_key` | 可留空（本地无鉴权实例） |
| 每页结果数 | `fts_meilisearch_page_size` | 上游默认 5 |
| AI 语义检索 | `fts_meilisearch_embed_enabled` | 对应上游 embedder（`cr-text`），配置 JSON 原样透传给 Meilisearch |
| Tika 地址 | `fts_tika_endpoint` | 例：`http://tika:9998` |
| 抽取扩展名 | `fts_tika_exts` | 上游默认 `pdf,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp,rtf,txt,md,html,htm,epub,csv` |
| 抽取体积上限 | `fts_tika_max_file_size` | 上游默认 25 MB |
| 分块大小 | `fts_chunk_size` | 上游默认 2000 字节 |

配好之后点面板上的 **「重建索引」**：每次调用清空旧索引、推一批文件（40 个），
文件多时再点一次就是继续 —— 任务列表里的进度条按真实进度走，不会假死。
之后**新上传的文件自动进索引**（走 `waitUntil`，不拖慢上传响应），
改名、删除、进回收站、恢复都会同步索引。

这两个服务（Meilisearch / Tika）是原版就要求的独立部署项，不是边缘版新增的负担；
原版怎么部署，边缘版就怎么连。

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
     只有 WebDAV 调用它。边缘版的 WebDAV 沿用普通 API 的行为：符号目录不可遍历
     （403）。也就是说通过 WebDAV 看不到「保存到我的网盘」的符号目录内容 ——
     如果需要，就用上面那个新增端点转存成真实文件。
3. **`groups.permissions` 的 `authn_enabled` 默认值已与上游对齐（`"1"`）。**
   Passkey 实现落地后，站点设置 `authn_enabled` 默认开启，登录页会出现
   Passkey 按钮；不想用就在管理后台把它关掉。
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
