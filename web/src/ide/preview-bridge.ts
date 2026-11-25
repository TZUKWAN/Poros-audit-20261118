/** A private MessagePort grants only a single run action to one opaque sandbox frame. */
export function attachPreview(target: Window, run: (input: unknown) => Promise<unknown>) {
  const channel = new MessageChannel();
  let busy = false,
    closed = false;
  const reply = (value: unknown) => {
    if (!closed)
      try {
        channel.port1.postMessage(value);
      } catch {
        /* The frame may already have been replaced. */
      }
  };
  channel.port1.onmessage = (event) => {
    const packet = event.data as { type?: string; id?: string; input?: unknown };
    if (packet?.type !== "run" || typeof packet.id !== "string" || !/^\d{1,8}$/.test(packet.id))
      return;
    if (busy) {
      reply({ id: packet.id, error: "已有试用正在运行" });
      return;
    }
    try {
      if (JSON.stringify(packet.input ?? null).length > 500000) throw new Error("输入超过大小限制");
    } catch {
      reply({ id: packet.id, error: "输入需要是可序列化且不超过 500 KB 的数据" });
      return;
    }
    busy = true;
    void run(packet.input)
      .then(
        (result) => reply({ id: packet.id, result }),
        (error) =>
          reply({ id: packet.id, error: error instanceof Error ? error.message : "运行失败" }),
      )
      .finally(() => {
        busy = false;
      });
  };
  channel.port1.start();
  target.postMessage({ type: "poros.connect" }, "*", [channel.port2]);
  return () => {
    closed = true;
    channel.port1.close();
  };
}
