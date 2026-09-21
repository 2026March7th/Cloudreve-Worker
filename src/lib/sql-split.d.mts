/**
 * sql-split.mjs 的类型声明。
 * tsconfig allowJs=false，tsc 靠这份 .d.mts 解析 `.mjs` 导入
 * （moduleResolution=bundler 下 `./sql-split.mjs` → `sql-split.d.mts`）。
 */
export declare function splitStatements(sqlText: string): string[];
