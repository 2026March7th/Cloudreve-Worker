# -*- coding: utf-8 -*-
"""
官方前端契约 vs edge 实现 的三态比对。

**为什么要按前端契约核对**：edge 接入的是官方前端
（cloudreve/frontend @ 19da0fe1ecd40971fafa813983d769fdce41573c），
它 `src/api/api.ts` 里每个 `send()` 调用都是一条必须被满足的契约。
上游 Go 有而前端不调的端点（如 `/slave/*`）可以不管；前端会调而 edge 没有的，
才是用户真正会撞上的。所以口径是「从前端出发」。

**为什么要分三态**：只看「路由是否存在」会把**桩**误判成已支持。
edge 的桩有两处写法，两种都以 `CodeFeatureNotEnabled` 收尾：
  1. `NOT_IMPLEMENTED*: Record<string, string> = { '/path': '...' }` + 循环 `.all(path, ...)`
  2. 直接的 `Routes.all('/path', (c) => ... CodeFeatureNotEnabled ...)`

用法：
    python scripts/scan-frontend-contract.py <前端 src/api 目录> [edge routes 目录] [输出目录]

例：
    git clone --filter=blob:none --no-checkout https://github.com/cloudreve/frontend.git
    cd frontend && git fetch --depth 1 origin 19da0fe1ecd40971fafa813983d769fdce41573c
    git checkout FETCH_HEAD && cd -
    python scripts/scan-frontend-contract.py ../frontend/src/api

输出：`_gap.json`（机器可读）+ `_gap_result.txt`（人读）。

两个踩过的坑，改这个脚本时别丢：
  - 前端路径是相对 `baseURL = "/api/v4"` 的，比对前必须剥前缀，否则全部误判为缺失；
  - Hono 的 `.all()` 等价于任意方法，提取时要把 `ALL` 归一成 `*`，否则桩会被漏掉。
"""
import re
import os
import json
import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))

FE_API_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "frontend", "src", "api")
EDGE_ROUTE_DIR = (
    sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "..", "src", "routes")
)
OUT_DIR = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, "..")
OUT_JSON = os.path.join(OUT_DIR, "_gap.json")
OUT_TXT = os.path.join(OUT_DIR, "_gap_result.txt")

STUB_MARK = "CodeFeatureNotEnabled"

PREFIX = {
    "siteRoutes": "/api/v4/site",
    "sessionRoutes": "/api/v4/session",
    "userRoutes": "/api/v4/user",
    "fileRoutes": "/api/v4/file",
    "shareRoutes": "/api/v4/share",
    "adminRoutes": "/api/v4/admin",
    # admin-content.ts 挂在 adminRoutes 的 "/" 下，路径是相对 /admin 的
    "adminContentRoutes": "/api/v4/admin",
    "workflowRoutes": "/api/v4/workflow",
    "devicesRoutes": "/api/v4/devices",
    "callbackRoutes": "/api/v4/callback",
    "webdavRoutes": "/api/v4/webdav",
}


# ---------------------------------------------------------------------------
# 前端提取
# ---------------------------------------------------------------------------

def read_str_literal(src, i):
    """读一个字符串字面量，正确处理模板串里的 ${...}（含嵌套引号/反引号）。"""
    q = src[i]
    j = i + 1
    buf = []
    while j < len(src):
        c = src[j]
        if c == "\\":
            buf.append(src[j:j + 2])
            j += 2
            continue
        if q == "`" and c == "$" and j + 1 < len(src) and src[j + 1] == "{":
            depth = 1
            j += 2
            instr = None
            while j < len(src) and depth > 0:
                cc = src[j]
                if instr:
                    if cc == "\\":
                        j += 2
                        continue
                    if cc == instr:
                        instr = None
                else:
                    if cc in "\"'`":
                        instr = cc
                    elif cc == "{":
                        depth += 1
                    elif cc == "}":
                        depth -= 1
                j += 1
            buf.append("{p}")
            continue
        if c == q:
            break
        buf.append(c)
        j += 1
    return "".join(buf)


def extract_frontend():
    out = []
    for fn in sorted(os.listdir(FE_API_DIR)):
        if not fn.endswith(".ts"):
            continue
        src = open(os.path.join(FE_API_DIR, fn), encoding="utf-8").read()
        for m in re.finditer(r"\bsend\(", src):
            i = m.end()
            while i < len(src) and src[i] in " \t\r\n":
                i += 1
            if i >= len(src) or src[i] not in "\"'`":
                continue
            url = read_str_literal(src, i)
            tail = src[i:i + 600]
            mm = re.search(r"method:\s*[\"']([A-Za-z]+)[\"']", tail)
            method = mm.group(1).upper() if mm else "GET"
            out.append({
                "file": fn, "url": url, "method": method,
                "trailing": url.split("?")[0].endswith("/"),
            })
    return out


# ---------------------------------------------------------------------------
# edge 提取
# ---------------------------------------------------------------------------

def normalize(p, trailing_dynamic=False):
    p = p.split("?")[0].strip()
    if not p.startswith("/"):
        p = "/" + p
    p = re.sub(r"([^/])\{p\}", r"\1/{p}", p)
    if trailing_dynamic and p.endswith("/"):
        p = p + "{p}"
    segs = []
    for s in p.split("/"):
        if s == "":
            continue
        segs.append("{p}" if (s.startswith(":") or s in ("{p}", "*")) else s)
    if segs[:2] == ["api", "v4"]:
        segs = segs[2:]
    return segs


def find_call_end(src, open_idx):
    """从 '(' 开始做括号配对，跳过字符串与注释，返回调用结束的下标。"""
    depth = 0
    i = open_idx
    n = len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":
            q = c
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == q:
                    break
                i += 1
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def extract_edge():
    out = []
    for fn in sorted(os.listdir(EDGE_ROUTE_DIR)):
        if not fn.endswith(".ts"):
            continue
        src = open(os.path.join(EDGE_ROUTE_DIR, fn), encoding="utf-8").read()

        regs = []
        for m in re.finditer(
            r"(\w+Routes)\.(get|post|patch|put|delete|all)\(\s*([\"'])([^\"']*)\3", src
        ):
            var, method, p = m.group(1), m.group(2).upper(), m.group(4)
            if var not in PREFIX:
                continue
            # Hono 的 .all() 等价于任意方法
            if method == "ALL":
                method = "*"
            open_idx = src.index("(", m.start())
            end_idx = find_call_end(src, open_idx)
            regs.append({
                "var": var, "method": method, "p": p,
                # 只看这个 handler 自己的代码块，避免把文件末尾的桩循环误算进来
                "body": src[open_idx:end_idx],
                "start": m.start(),
            })

        # NOT_IMPLEMENTED* 字典里的 key，通过它下面的循环注册推断前缀变量
        for dm in re.finditer(
            r"NOT_IMPLEMENTED\w*:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};", src
        ):
            block = dm.group(1)
            loop = re.search(
                r"Object\.entries\(NOT_IMPLEMENTED\w*\)\)\s*\{\s*(\w+Routes)\.all\(path",
                src[dm.end():dm.end() + 400],
            )
            var = loop.group(1) if loop else None
            if var not in PREFIX:
                continue
            for km in re.finditer(r"[\"']([^\"']+)[\"']\s*:", block):
                out.append({
                    "var": var, "method": "*", "path": (PREFIX[var] + km.group(1)).rstrip("/"),
                    "file": fn, "stub": True, "wildcard": False,
                })

        for reg in regs:
            full = (PREFIX[reg["var"]] + reg["p"]).rstrip("/") or PREFIX[reg["var"]]
            # 桩的判定：handler 体引用 CodeFeatureNotEnabled **且**没有任何
            # await（真正的桩是纯同步返回 40019）。像 workflow/download、
            # workflow/rebuildFtsIndex 这类「正常实现 + 特定分支报 40019」的
            # handler 里也有这个常量，不能凭出现就判成桩。
            is_stub = STUB_MARK in reg["body"] and "await" not in reg["body"]
            out.append({
                "var": reg["var"], "method": reg["method"], "path": full,
                "file": fn, "stub": is_stub,
                "wildcard": reg["p"].endswith("/*"),
            })

    for d in out:
        d["segs"] = normalize(d["path"])
    return out


def matches(fe_segs, ed):
    """前端路径是否被这条 edge 路由接住。"""
    a, b = list(fe_segs), list(ed["segs"])
    # Hono 的 /* 是前缀通配，能吃掉任意多段
    if ed.get("wildcard"):
        pre = b[:-1] if b and b[-1] == "{p}" else b
        if len(a) < len(pre):
            return False
        return all(x == "{p}" or y == "{p}" or x == y for x, y in zip(a[:len(pre)], pre))
    if len(b) == len(a) + 1 and b[-1] == "{p}":
        b = b[:-1]
    if len(a) == len(b) + 1 and a[-1] == "{p}":
        a = a[:-1]
    if len(a) != len(b):
        return False
    return all(x == "{p}" or y == "{p}" or x == y for x, y in zip(a, b))


def main():
    fe = extract_frontend()
    ed = extract_edge()

    seen = {}
    for r in fe:
        key = (r["url"], r["method"])
        if key not in seen:
            seen[key] = {"url": r["url"], "method": r["method"],
                         "files": [r["file"]], "trailing": r["trailing"]}
        elif r["file"] not in seen[key]["files"]:
            seen[key]["files"].append(r["file"])
    fe_uniq = list(seen.values())

    implemented, stubbed, missing = [], [], []
    for r in fe_uniq:
        segs = normalize(r["url"], r.get("trailing", False))
        hits = [d for d in ed
                if (d["method"] == r["method"] or d["method"] == "*")
                and matches(segs, d)]
        if not hits:
            missing.append(r)
        elif any(not d["stub"] for d in hits):
            implemented.append({**r, "coveredBy": [d["path"] for d in hits if not d["stub"]][0]})
        else:
            stubbed.append({**r, "stubBy": hits[0]["path"]})

    report = {
        "summary": {
            "frontendContracts": len(fe_uniq),
            "edgeRouteDeclarations": len(ed),
            "implemented": len(implemented),
            "stubbed": len(stubbed),
            "missing": len(missing),
            "edgeStubTotal": sum(1 for d in ed if d["stub"]),
        },
        "implemented": sorted([{"method": r["method"], "url": r["url"]} for r in implemented],
                              key=lambda x: (x["url"], x["method"])),
        "stubbed": sorted([{"method": r["method"], "url": r["url"], "stubBy": r["stubBy"]}
                           for r in stubbed], key=lambda x: (x["url"], x["method"])),
        "missing": sorted([{"method": r["method"], "url": r["url"]} for r in missing],
                          key=lambda x: (x["url"], x["method"])),
        "edgeStubs": sorted([{"method": d["method"], "path": d["path"]}
                             for d in ed if d["stub"]], key=lambda x: (x["path"], x["method"])),
    }
    json.dump(report, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    s = report["summary"]
    L = []
    L.append("前端契约(去重) %d 条" % s["frontendContracts"])
    L.append("edge 路由声明 %d 条，其中桩 %d 条" % (s["edgeRouteDeclarations"], s["edgeStubTotal"]))
    L.append("")
    L.append("  [实现] %d 条" % s["implemented"])
    L.append("  [桩]   %d 条   <- 前端能点到，但一律返回 40019" % s["stubbed"])
    L.append("  [缺失] %d 条   <- 前端能点到，但后端没有这个路由（404 / 落到别的 handler）" % s["missing"])
    L.append("")
    L.append("=" * 68)
    L.append("【一】桩：前端有入口，点了报「功能未开启」")
    L.append("=" * 68)
    for r in report["stubbed"]:
        L.append("   %-6s %-34s  (桩: %s)" % (r["method"], r["url"], r["stubBy"]))
    L.append("")
    L.append("=" * 68)
    L.append("【二】缺失：前端有入口，后端没有对应路由")
    L.append("=" * 68)
    for r in report["missing"]:
        L.append("   %-6s %s" % (r["method"], r["url"]))
    L.append("")
    L.append("=" * 68)
    L.append("【三】edge 里声明了但返回 40019 的所有桩路由（含前端未直接调用的）")
    L.append("=" * 68)
    for d in report["edgeStubs"]:
        L.append("   %-6s %s" % (d["method"], d["path"]))

    open(OUT_TXT, "w", encoding="utf-8").write("\n".join(L))
    print("implemented=%d stubbed=%d missing=%d" % (s["implemented"], s["stubbed"], s["missing"]))


main()
