/**
 * 后端版本号。放在 lib 里是为了让存储驱动（`storage/nodeRelay.ts`）也能引用，
 * 而不必从 `routes/site` 反向导入（那会绕出路由 → 服务 → 存储的循环依赖）。
 */
export const BACKEND_VERSION = '4.19.1';
