import dgram, { type RemoteInfo } from "node:dgram";
import { randomUUID } from "node:crypto";

export const OMNIHOST_PROTOCOL = "control-deck-omnihost/1";

export interface OmnihostStatus {
  connected: boolean;
  protocol: string;
  host: string;
  port: number;
  pluginName: string;
  pluginFormat: "vst3";
  pluginPath: string;
  catalogReady: boolean;
  parameterCount: number;
  indexedParameterCount: number;
  usefulParameterCount: number;
  helperParameterCount: number;
  startedAt: string;
  lastError: string | null;
}

export interface OmnihostParameter {
  index: number;
  name: string;
  helper: boolean;
}

export interface OmnihostParameterValue extends OmnihostParameter {
  pluginName: string;
  normalizedValue: number;
  displayValue: string;
}

export interface OmnihostParameterPage {
  pluginName: string;
  query: string;
  includeHelpers: boolean;
  matched: number;
  returned: number;
  offset: number;
  limit: number;
  truncated: boolean;
  parameters: OmnihostParameter[];
}

export interface OmnihostControlClient {
  status(): Promise<OmnihostStatus>;
  listParameters(input?: { query?: string; includeHelpers?: boolean; limit?: number; offset?: number }): Promise<OmnihostParameterPage>;
  getParameter(input: { expectedPluginName: string; parameterIndex: number; expectedParameterName: string }): Promise<OmnihostParameterValue>;
  setParameter(input: { expectedPluginName: string; parameterIndex: number; expectedParameterName: string; normalizedValue: number }): Promise<OmnihostParameterValue & { previousNormalizedValue: number; previousDisplayValue: string; requestedNormalizedValue: number }>;
  openEditor(): Promise<{ pluginName: string; opened: boolean }>;
  refreshCatalog(): Promise<{ pluginName: string; refreshStarted: boolean }>;
}

export interface OmnihostClientOptions {
  host?: string;
  port?: number;
  localAddress?: string;
  timeoutMs?: number;
}

interface OmnihostResponse<T = unknown> {
  protocol: string;
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; details?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class OmnihostError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "OmnihostError";
  }
}

export class OmnihostClient implements OmnihostControlClient {
  private readonly socket = dgram.createSocket("udp4");
  private readonly ready: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;

  constructor(options: OmnihostClientOptions = {}) {
    this.host = options.host ?? process.env.CONTROL_DECK_OMNIHOST_HOST ?? "127.0.0.1";
    this.port = options.port ?? Number(process.env.CONTROL_DECK_OMNIHOST_PORT ?? 50714);
    this.timeoutMs = options.timeoutMs ?? Number(process.env.CONTROL_DECK_OMNIHOST_TIMEOUT_MS ?? 3000);
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("listening", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (message, remote) => this.handleDatagram(message, remote));
    this.socket.on("error", error => this.rejectAll(error));
    this.socket.bind(0, options.localAddress ?? "127.0.0.1");
  }

  status(): Promise<OmnihostStatus> { return this.request("omnihost.status"); }

  listParameters(input: { query?: string; includeHelpers?: boolean; limit?: number; offset?: number } = {}): Promise<OmnihostParameterPage> {
    return this.request("omnihost.list_parameters", input, 5000);
  }

  getParameter(input: { expectedPluginName: string; parameterIndex: number; expectedParameterName: string }): Promise<OmnihostParameterValue> {
    return this.request("omnihost.get_parameter", input);
  }

  setParameter(input: { expectedPluginName: string; parameterIndex: number; expectedParameterName: string; normalizedValue: number }): Promise<OmnihostParameterValue & { previousNormalizedValue: number; previousDisplayValue: string; requestedNormalizedValue: number }> {
    return this.request("omnihost.set_parameter", input);
  }

  openEditor(): Promise<{ pluginName: string; opened: boolean }> { return this.request("omnihost.open_editor"); }
  refreshCatalog(): Promise<{ pluginName: string; refreshStarted: boolean }> { return this.request("omnihost.refresh_catalog"); }

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) throw new OmnihostError("OMNIHOST_CLOSED", "Control Deck OmniHost client is closed.");
    await this.ready;
    const id = randomUUID();
    const datagram = Buffer.from(JSON.stringify({ protocol: OMNIHOST_PROTOCOL, id, method, params }), "utf8");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OmnihostError("OMNIHOST_TIMEOUT", `Control Deck OmniHost timed out waiting for ${method}. Is the device loaded in Live?`));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket.send(datagram, this.port, this.host, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new OmnihostError("OMNIHOST_CLOSED", "Control Deck OmniHost client closed."));
    this.socket.close();
  }

  private handleDatagram(message: Buffer, remote: RemoteInfo): void {
    if (remote.address !== this.host && remote.address !== "::ffff:127.0.0.1") return;
    let response: OmnihostResponse;
    try { response = JSON.parse(message.toString("utf8")) as OmnihostResponse; }
    catch { return; }
    if (response.protocol !== OMNIHOST_PROTOCOL || typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (!response.ok) {
      pending.reject(new OmnihostError(response.error?.code ?? "OMNIHOST_ERROR", response.error?.message ?? "Control Deck OmniHost request failed.", response.error?.details));
      return;
    }
    pending.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

