// Generated file — do not edit.
/**
 * Minimal Chrome DevTools Protocol client over the platform
 * WebSocket (Node 22+). Used only on the trusted executor side of the
 * Guardian–Steel boundary; the untrusted agent never receives this socket.
 */

export type CdpMessage = Readonly<{
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  sessionId?: string;
}>;

export interface CdpConnection {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  waitForEvent(
    method: string,
    sessionId: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

type WebSocketLike = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultFactory: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

export async function connectCdp(input: {
  webSocketUrl: string;
  timeoutMs?: number;
  webSocket?: WebSocketFactory;
}): Promise<CdpConnection> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const socket = (input.webSocket ?? defaultFactory)(input.webSocketUrl);
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(e: Error): void }
  >();
  const waiters: {
    method: string;
    sessionId: string;
    resolve(value: Record<string, unknown>): void;
  }[] = [];

  const failAll = (reason: string) => {
    closed = true;
    for (const entry of pending.values()) entry.reject(new Error(reason));
    pending.clear();
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CDP_CONNECT_TIMEOUT")),
      timeoutMs,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP_CONNECT_FAILED"));
    };
  });
  socket.onerror = () => failAll("CDP_SOCKET_ERROR");
  socket.onclose = () => failAll("CDP_SOCKET_CLOSED");
  socket.onmessage = (event) => {
    let message: CdpMessage;
    try {
      message = JSON.parse(String(event.data)) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(new Error(`CDP_ERROR:${message.error.message ?? ""}`));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method === undefined) return;
    const index = waiters.findIndex(
      (waiter) =>
        waiter.method === message.method &&
        waiter.sessionId === message.sessionId,
    );
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter!.resolve(message.params ?? {});
    }
  };

  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error("CDP_SOCKET_CLOSED"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP_TIMEOUT:${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
      });
    },
    waitForEvent(method, sessionId, waitMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`CDP_EVENT_TIMEOUT:${method}`));
        }, waitMs);
        const waiter = {
          method,
          sessionId,
          resolve: (value: Record<string, unknown>) => {
            clearTimeout(timer);
            resolve(value);
          },
        };
        waiters.push(waiter);
      });
    },
    close() {
      closed = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}
