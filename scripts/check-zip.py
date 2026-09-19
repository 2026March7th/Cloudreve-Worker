"""校验 scripts/verify-zip.cjs 生成的 ZIP 是否真的能被标准解压器读取。

用法：python scripts/check-zip.py
依赖：_verify/normal.zip 与 _verify/empty.zip（由 verify-zip.cjs 生成）
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERIFY = os.path.join(ROOT, "_verify")

EXPECTED = {
    "hello.txt": "Hello, ZIP! 这是一段用于验证的中文文本。",
    "nested/deep/中文文件.txt": "Hello, ZIP! 这是一段用于验证的中文文本。",
}

failures = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (("  " + detail) if detail else ""))
    if not ok:
        failures.append(name)


def main():
    normal = os.path.join(VERIFY, "normal.zip")
    empty = os.path.join(VERIFY, "empty.zip")

    if not os.path.exists(normal):
        print("missing " + normal + ", run verify-zip.cjs first")
        sys.exit(1)

    with zipfile.ZipFile(normal) as zf:
        # testzip() 会把每个条目的 CRC 与头部记录比对，返回第一个损坏的条目名
        bad = zf.testzip()
        check("testzip() 无损坏条目", bad is None, str(bad))

        names = zf.namelist()
        check("条目数量 = 4", len(names) == 4, str(names))

        # 空目录条目：名字以 / 结尾
        check("空目录条目存在", "empty-dir/" in names, str(names))

        for name, want in EXPECTED.items():
            got = zf.read(name).decode("utf-8")
            check("内容一致: " + name, got == want)

        # 中文文件名依赖 UTF-8 flag，读不出来说明 flag 写错了
        check("中文文件名可读", "nested/deep/中文文件.txt" in names)

        # 二进制条目逐字节比对
        with zf.open("bin.dat") as f:
            data = f.read()
        want = bytes(i & 0xFF for i in range(512))
        check("二进制条目 512 字节一致", data == want, str(len(data)))

        # store 模式：压缩后大小应等于原始大小
        for info in zf.infolist():
            if info.filename == "bin.dat":
                check(
                    "store 模式（compress_size == file_size）",
                    info.compress_size == info.file_size,
                    f"{info.compress_size} vs {info.file_size}",
                )

    # 空包：合法 EOCD，0 条目
    with zipfile.ZipFile(empty) as zf:
        check("空包条目数 = 0", len(zf.namelist()) == 0, str(zf.namelist()))

    if failures:
        print(f"\n{len(failures)} FAILED")
        sys.exit(1)
    print("\nALL PASS")


main()
