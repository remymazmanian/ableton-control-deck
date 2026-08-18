import dgram from "node:dgram";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OMNIHOST_PROTOCOL, OmnihostClient } from "../src/omnihost-client.js";

describe("OmnihostClient", () => {
  const server = dgram.createSocket("udp4");
  let client: OmnihostClient;
  let port = 0;

  beforeAll(async () => {
    server.on("message", (message, remote) => {
      const request = JSON.parse(message.toString("utf8")) as { id: string; method: string; params: Record<string, unknown> };
      const result = request.method === "omnihost.status"
        ? { connected: true, pluginName: "Mini V4", catalogReady: true, parameterCount: 2663 }
        : { pluginName: "Mini V4", query: request.params.query ?? "", matched: 1, returned: 1, parameters: [{ index: 29, name: "Filter Cutoff", helper: false }] };
      server.send(Buffer.from(JSON.stringify({ protocol: OMNIHOST_PROTOCOL, id: request.id, ok: true, result })), remote.port, remote.address);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.bind(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
    client = new OmnihostClient({ port, timeoutMs: 1000 });
  });

  afterAll(() => { client.close(); server.close(); });

  it("reads OmniHost status", async () => {
    await expect(client.status()).resolves.toMatchObject({ connected: true, pluginName: "Mini V4", parameterCount: 2663 });
  });

  it("sends parameter search inputs", async () => {
    await expect(client.listParameters({ query: "cutoff", limit: 20 })).resolves.toMatchObject({ matched: 1, parameters: [{ index: 29, name: "Filter Cutoff" }] });
  });
});

