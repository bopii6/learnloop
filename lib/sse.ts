// 浏览器侧 SSE 消费（教学/建课/问答三处共用）：
// - 按空行切帧，兼容 \r\n；一帧内多条 data: 行按 SSE 规范拼接
// - 流结束时冲刷残留的最后一帧（服务端异常断开时可能没有结尾空行，不冲刷会丢 done/error 事件）
export async function consumeSse<T>(res: Response, onEvent: (e: T) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const handleFrame = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    try {
      onEvent(JSON.parse(data) as T);
    } catch {
      // 忽略坏帧
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() || "";
    for (const part of parts) handleFrame(part);
  }
  if (buf.trim()) handleFrame(buf);
}
