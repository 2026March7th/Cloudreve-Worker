# 官方前端契约覆盖度

这份文档记录**官方前端会调用、但 edge 侧还没实现**的端点，是后续开发的清单。

## 为什么要按「前端契约」而不是「上游路由」来核对

edge 接入的前端是官方仓库 `cloudreve/frontend`，固定提交
`19da0fe1ecd40971fafa813983d769fdce41573c`（v4.14.0 配套）。

前端 `src/api/api.ts` 里每一个 `send()` 调用就是一条**必须被满足的契约**。
上游 Go 后端有而前端不调的端点（如 `/slave/*`）可以放着不管；
反过来，前端会调而 edge 没有的，才是用户真正会撞上的东西。

所以核对口径是：**从前端出发，逐条比对 edge**。

## 三态

只看「路由是否存在」会把**桩**误判成已支持，所以必须分三态：

| 状态 | 含义 |
|---|---|
| 已实现 | 路由存在，且 handler 不是桩 |
| 桩 | 路由存在，但一律返回 `40019`（`CodeFeatureNotEnabled`） |
| 缺失 | 路由根本不存在 —— 请求要么 404，要么被别的通配路由接住 |

## 当前统计

```
前端契约（去重）  127 条
edge 路由声明     148 条，其中桩 10 条

  已实现  120 条
  桩        7 条
  缺失      0 条   ← 2026-09-19 归零
```

> 桩判定规则：handler 体引用 `CodeFeatureNotEnabled` **且没有任何 await**。
> 像 `workflow/download`、`workflow/rebuildFtsIndex` 这类「正常实现 + 特定
> 分支报 40019」的端点不会被误判成桩。

复算方式（结果写进 `_gap_result.txt`）：

```bash
python scripts/scan-frontend-contract.py <官方前端>/src/api src/routes .
```

> 下面第二节、第三节是**首轮盘点时的原始清单**，列出的项已全部补上或收敛为
> 桩（后台文件/实体/分享管理、节点、OAuth 授权、WebDAV、Passkey、两步验证、
> 全文搜索、workflow、打包）。以 `_gap_result.txt` 的实时输出为准。

## 一、桩：前端有入口，点了报「功能未开启」

| 方法 | 端点 | 被哪条桩接住 |
|---|---|---|
| POST | `/admin/queue/batch/delete` | `/api/v4/admin/queue/batch/delete` |
| POST | `/admin/queue/cleanup` | `/api/v4/admin/queue/:id` |
| GET | `/admin/queue/metrics` | `/api/v4/admin/queue/:id` |
| GET | `/admin/queue/{id}` | `/api/v4/admin/queue/:id` |
| DELETE | `/admin/tool/entityUrlCache` | `/api/v4/admin/tool/entityUrlCache` |
| POST | `/admin/tool/thumbExecutable` | `/api/v4/admin/tool/thumbExecutable` |
| GET | `/admin/tool/wopi` | `/api/v4/admin/tool/wopi` |
| GET | `/callback/{policyType}/{sid}/{key}` | `/api/v4/callback/*` |
| GET | `/file/archive` | `/api/v4/file/archive` |
| GET | `/file/search` | `/api/v4/file/search` |
| PUT | `/file/viewerSession` | `/api/v4/file/viewerSession` |
| POST | `/session/authn` | `/api/v4/session/authn` |
| PUT | `/session/authn` | `/api/v4/session/authn` |
| POST | `/session/token/2fa` | `/api/v4/session/token/2fa` |

## 二、缺失：前端有入口，后端没有对应路由

### 管理后台（占大头，共 36 条）

| 方法 | 端点 | 说明 |
|---|---|---|
| POST / GET / PUT / DELETE | `/admin/user`、`/admin/user/{id}` | 用户详情、编辑 |
| POST | `/admin/user/batch/delete` | 批量删除用户 |
| POST | `/admin/user/{id}/calibrate` | 重算用户容量 |
| POST / GET / PUT / DELETE | `/admin/file`、`/admin/file/{id}` | 文件管理标签页 |
| POST | `/admin/file/batch/delete` | |
| GET | `/admin/file/url/{id}` | |
| POST / GET / DELETE | `/admin/entity`、`/admin/entity/{id}` | 实体管理标签页 |
| POST | `/admin/entity/batch/delete` | |
| GET | `/admin/entity/url/{id}` | |
| POST / GET / DELETE | `/admin/share`、`/admin/share/{id}` | 分享管理标签页 |
| POST | `/admin/share/batch/delete` | |
| POST / GET / PUT / DELETE | `/admin/node`、`/admin/node/{id}` | 节点（多节点集群） |
| POST | `/admin/node/test`、`/admin/node/test/downloader` | |
| POST / GET / PUT / DELETE | `/admin/oauthClient`、`/admin/oauthClient/{id}` | OAuth 应用管理 |
| POST | `/admin/oauthClient/batch/delete` | |
| GET | `/admin/policy/{id}` | 存储策略详情 |
| POST | `/admin/policy/cors` | 配置桶 CORS |
| POST | `/admin/policy/oauth/signin`、`/oauth/callback` | 策略 OAuth 授权 |
| GET | `/admin/policy/oauth/redirect`、`/oauth/status/{id}`、`/oauth/root/{id}` | |

### 协议与功能（共 18 条）

| 方法 | 端点 | 说明 |
|---|---|---|
| GET / PUT / PATCH / DELETE | `/devices/dav`、`/devices/dav/{id}` | WebDAV 账户管理（4 条）。`dav_accounts` 表未建 |
| GET | `/session/oauth/app/{id}` | 第三方应用授权页 |
| POST | `/session/oauth/consent` | 用户同意授权 |
| DELETE | `/session/oauth/grant/{id}` | 撤销授权 |
| POST / PUT / DELETE | `/user/authn`、`/user/authn?id=` | Passkey 注册与删除（3 条）。`passkeys` 表未建 |
| GET | `/user/setting/2fa` | 两步验证初始化（TOTP） |
| GET / POST / PATCH / DELETE | `/workflow`、`/workflow/{archive,extract,download,import,rebuildFtsIndex,progress}` | 任务队列（9 条）：打包下载、解压、远程下载、导入、全文索引重建 |

## 三、edge 里声明了但返回 40019 的所有桩

含前端未直接调用的：

```
*      /api/v4/admin/queue/:id
*      /api/v4/admin/queue/batch/delete
*      /api/v4/admin/queue/cleanup
*      /api/v4/admin/tool/entityUrlCache
*      /api/v4/admin/tool/thumbExecutable
*      /api/v4/admin/tool/wopi
*      /api/v4/callback/*
*      /api/v4/file/archive
*      /api/v4/file/archive/:sessionID/archive.zip
*      /api/v4/file/events
*      /api/v4/file/search
*      /api/v4/file/viewerSession
*      /api/v4/file/wopi
*      /api/v4/session/authn
*      /api/v4/session/token/2fa
```

## 怎么重新生成这份清单

脚本在 `scripts/scan-frontend-contract.py`。它从前端源码提取所有 `send()` 调用，
与 edge 的路由声明做集合比对，并识别桩。

```bash
# 1. 拉官方前端（只取那一个提交，不拉全历史）
git clone --filter=blob:none --no-checkout https://github.com/cloudreve/frontend.git
cd frontend
git fetch --depth 1 origin 19da0fe1ecd40971fafa813983d769fdce41573c
git checkout FETCH_HEAD

# 2. 扫描
python scripts/scan-frontend-contract.py <前端>/src/api
```

输出 `_gap.json`（机器可读）与 `_gap_result.txt`（人读）。

### 两个容易搞错的地方

1. **前端路径是相对 `baseURL = "/api/v4"` 的**，比对前必须剥掉这个前缀，
   否则会全部误判为缺失（踩过）。
2. **Hono 的 `.all()` 等价于任意方法**，提取时要把 `ALL` 归一成 `*`，
   否则桩会被漏掉（踩过）。
