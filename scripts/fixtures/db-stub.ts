/** 测试用的 db 桩：限速单测都注入内存 store，正常不会走到这里。 */
export function getSql(): never {
  throw new Error('getSql() is not available in unit tests — inject a RateLimitStore');
}
