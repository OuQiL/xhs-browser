/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Uses only Node's built-in globals (`WebSocket`, `fetch`), so the plugin adds
 * no dependency and needs no bundler. Message routing is flat: one socket can
 * carry browser-level commands and any number of `Target.attachToTarget`
 * sessions distinguished by `sessionId`.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export class CdpError extends Error {
  constructor(message, { method, code } = {}) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

export class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.closeError = undefined;
  }

  static async open(url, { timeoutMs = 15_000 } = {}) {
    const connection = new CdpConnection(url);
    await connection.connect(timeoutMs);
    return connection;
  }

  connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        reject(new CdpError(`cannot open CDP socket ${this.url}: ${error.message}`));
        return;
      }
      this.socket = socket;
      const settle = (fn, value) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        fn(value);
        return true;
      };
      const timer = setTimeout(() => {
        settle(reject, new CdpError(`CDP connect timed out after ${timeoutMs}ms: ${this.url}`));
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      }, timeoutMs);

      socket.addEventListener('open', () => settle(resolve, undefined));
      socket.addEventListener('message', (event) => this.#dispatch(event.data));
      socket.addEventListener('error', () => {
        settle(reject, new CdpError(`CDP socket error: ${this.url}`));
      });
      socket.addEventListener('close', () => {
        this.closed = true;
        const error = this.closeError ?? new CdpError(`CDP connection closed: ${this.url}`);
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(error);
        }
        this.pending.clear();
        settle(reject, error);
      });
    });
  }

  #dispatch(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;

    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        entry.reject(
          new CdpError(`${entry.method} failed: ${message.error.message}`, {
            method: entry.method,
            code: message.error.code,
          }),
        );
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    const listeners = this.listeners.get(message.method);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(message.params ?? {}, message.sessionId);
      } catch {
        /* a listener failure must not break protocol routing */
      }
    }
  }

  /** Subscribe to one CDP event. Returns the unsubscribe function. */
  on(method, listener) {
    let listeners = this.listeners.get(method);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  /** Resolve with the first matching event, or reject on timeout. */
  waitFor(method, { sessionId, timeoutMs = 15_000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`timed out after ${timeoutMs}ms waiting for ${method}`, { method }));
      }, timeoutMs);
      off = this.on(method, (params, sid) => {
        if (sessionId !== undefined && sid !== sessionId) return;
        if (predicate !== undefined && !predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  /** Send one command. `sessionId` routes it to an attached target session. */
  send(method, params = {}, { sessionId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new CdpError(`CDP connection closed: ${this.url}`));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, { method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`${method} could not be sent: ${error.message}`, { method }));
      }
    });
  }

  close(reason) {
    if (this.closed) return;
    this.closeError = reason === undefined ? undefined : new CdpError(reason);
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }
}

/** `GET http://host:port/json/version`, retried until Chrome is listening. */
export async function fetchVersion(port, { host = '127.0.0.1', timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const response = await fetch(`http://${host}:${port}/json/version`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (typeof body?.webSocketDebuggerUrl === 'string') return body;
      }
      lastError = new Error(`unexpected /json/version status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new CdpError(
        `Chrome DevTools endpoint on port ${port} did not answer within ${timeoutMs}ms (${lastError?.message ?? 'no response'})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
