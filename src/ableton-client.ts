import dgram, { type RemoteInfo } from "node:dgram";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LiveControlClient, OscArgument, OscReply, OscTypedNumber } from "./types.js";
import { fromProjectRoot } from "./paths.js";

export const BRIDGE_PROTOCOL = "ableton-control-deck/1";
export const TOKEN_FILE = "data/bridge-token";

export function readBridgeToken(): string {
  if (process.env.CONTROL_DECK_TOKEN) return process.env.CONTROL_DECK_TOKEN;
  try {
    const token = readFileSync(fromProjectRoot(TOKEN_FILE), "utf8").trim();
    if (token) return token;
  } catch {}
  throw new Error(
    "No Control Deck bridge token found. Run `npm run setup` once to generate data/bridge-token and install the remote script, or set CONTROL_DECK_TOKEN."
  );
}

export interface AbletonClientOptions {
  host?: string;
  port?: number;
  localAddress?: string;
  timeoutMs?: number;
  token?: string;
}

export interface AbletonPlugin {
  name: string;
  path: string;
  format: "vst3" | "vst2" | "au" | "auv2";
}

interface BridgeResponse<T = unknown> {
  protocol: string;
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; details?: unknown };
}

interface BridgeChunk {
  protocol: string;
  id: string;
  chunk: { index: number; total: number; encoding: "base64" };
  payload: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  chunks: Map<number, Buffer>;
  expectedChunks?: number;
}

export class AbletonBridgeError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "AbletonBridgeError";
  }
}

export class AbletonClient implements LiveControlClient {
  private readonly socket = dgram.createSocket("udp4");
  private readonly ready: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly token: string;

  constructor(options: AbletonClientOptions = {}) {
    this.host = options.host ?? process.env.CONTROL_DECK_HOST ?? "127.0.0.1";
    this.port = options.port ?? Number(process.env.CONTROL_DECK_PORT ?? 50711);
    this.timeoutMs = options.timeoutMs ?? Number(process.env.CONTROL_DECK_TIMEOUT_MS ?? 5000);
    this.token = options.token ?? readBridgeToken();
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("listening", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (message, remote) => this.handleDatagram(message, remote));
    this.socket.on("error", error => this.rejectAll(error));
    this.socket.bind(0, options.localAddress ?? process.env.CONTROL_DECK_LOCAL_ADDRESS ?? "127.0.0.1");
  }

  status(): Promise<Record<string, unknown>> {
    return this.request("bridge.status");
  }

  listPlugins(input: { query?: string; format?: AbletonPlugin["format"]; limit?: number; offset?: number }): Promise<{ plugins: AbletonPlugin[]; returned: number; matched: number; offset: number; limit: number; truncated: boolean }> {
    return this.request("plugins.list", input, 12_000);
  }

  resolvePlugin(name: string, format: AbletonPlugin["format"], path?: string): Promise<{ plugin: AbletonPlugin }> {
    return this.request("plugins.resolve", { name, format, ...(path ? { path } : {}) }, 12_000);
  }

  loadPlugin(input: { trackIndex: number; expectedTrackName: string; name: string; format: AbletonPlugin["format"]; path: string }): Promise<Record<string, unknown>> {
    return this.request("plugins.load", input, 12_000);
  }

  refreshPlugins(): Promise<{ pluginCount: number; cacheBuiltAt: string }> {
    return this.request("plugins.refresh", {}, 30_000);
  }

  loadUserDevice(input: { trackIndex: number; expectedTrackName: string; name: string; path?: string }): Promise<Record<string, unknown>> {
    return this.request("devices.load_user_item", input, 12_000);
  }

  resolveUserLibraryItem(name: string, path?: string): Promise<{ item: { name: string; path: string; kind: string } }> {
    return this.request("devices.resolve_user_item", { name, ...(path ? { path } : {}) }, 12_000);
  }

  resolveBrowserDevice(name: string, path?: string): Promise<{ device: { name: string; path: string; kind: string } }> {
    return this.request("devices.resolve_browser_item", { name, ...(path ? { path } : {}) }, 12_000);
  }

  loadBrowserDevice(input: { trackIndex: number; expectedTrackName: string; name: string; path?: string }): Promise<Record<string, unknown>> {
    return this.request("devices.load_browser_item", input, 12_000);
  }

  async send(address: string, args: OscArgument[] = []): Promise<void> {
    await this.request("live.command", { address, args: args.map(unwrapArgument) });
  }

  query(address: string, args: OscArgument[] = [], _expectedAddress = address): Promise<OscReply> {
    return this.request("live.query", { address, args: args.map(unwrapArgument) });
  }

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closed) throw new Error("Bridge client is closed.");
    await this.ready;
    const id = randomUUID();
    const request = Buffer.from(JSON.stringify({ protocol: BRIDGE_PROTOCOL, id, token: this.token, method, params }), "utf8");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AbletonBridgeError("BRIDGE_TIMEOUT", `Control Deck Bridge timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer, chunks: new Map() });
      this.socket.send(request, this.port, this.host, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleDatagram(message: Buffer, remote: RemoteInfo): void {
    if (remote.port !== this.port || (this.host === "127.0.0.1" && remote.address !== "127.0.0.1")) return;
    let parsed: BridgeResponse | BridgeChunk;
    try { parsed = parseBridgeDatagram(message); }
    catch { return; }
    if (parsed.protocol !== BRIDGE_PROTOCOL) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    if ("chunk" in parsed) {
      const { index, total, encoding } = parsed.chunk;
      if (encoding !== "base64" || index < 1 || total < 1 || index > total || total > 10_000) return;
      if (pending.expectedChunks !== undefined && pending.expectedChunks !== total) return;
      pending.expectedChunks = total;
      try { pending.chunks.set(index, Buffer.from(parsed.payload, "base64")); }
      catch { return; }
      if (pending.chunks.size !== total) return;
      const raw = Buffer.concat(Array.from({ length: total }, (_unused, position) => pending.chunks.get(position + 1) ?? Buffer.alloc(0)));
      try { this.finish(parsed.id, JSON.parse(raw.toString("utf8")) as BridgeResponse); }
      catch { this.fail(parsed.id, new AbletonBridgeError("INVALID_RESPONSE", "Control Deck Bridge returned invalid chunked JSON.")); }
      return;
    }
    this.finish(parsed.id, parsed);
  }

  private finish(id: string, response: BridgeResponse): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (!response.ok) {
      const error = response.error ?? { code: "BRIDGE_ERROR", message: "Unknown bridge error." };
      pending.reject(new AbletonBridgeError(error.code, error.message, error.details));
      return;
    }
    pending.resolve(response.result);
  }

  private fail(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const [id] of this.pending) this.fail(id, error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("Bridge client closed."));
    this.socket.close();
  }
}

export function parseBridgeDatagram(message: Buffer): BridgeResponse | BridgeChunk {
  const parsed = JSON.parse(message.toString("utf8")) as BridgeResponse | BridgeChunk;
  if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string" || typeof parsed.protocol !== "string") throw new Error("Invalid bridge datagram.");
  if (!("chunk" in parsed) && typeof parsed.ok !== "boolean") throw new Error("Invalid bridge response.");
  return parsed;
}

function unwrapArgument(value: OscArgument): string | number | boolean {
  return typeof value === "object" ? (value as OscTypedNumber).value : value;
}
