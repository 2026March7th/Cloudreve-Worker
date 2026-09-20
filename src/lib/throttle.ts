/**
 * 按字节/秒节流的可读流包装。对应上游 `entitysource` 的令牌桶限速
 * （ratelimit.NewBucketWithRate(bps, bps)）—— 这里用「每片读完睡
 * size/bps 毫秒」的等价近似，Workers 环境没有定时器精度可讲究，
 * 足够把平均速率压在限值附近。
 */

export function throttleStream(
  source: ReadableStream<Uint8Array>,
  bytesPerSec: number,
): ReadableStream<Uint8Array> {
  const bps = Math.max(1, Math.floor(bytesPerSec));
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= source.getReader();
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
      await sleep((value.length / bps) * 1000);
    },
    cancel(reason) {
      return source.cancel(reason);
    },
  });
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
