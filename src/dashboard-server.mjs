#!/usr/bin/env node
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPluginIndex, readPluginIndex, searchPluginIndex } from "./plugin-index.mjs";

const { version: SERVICE_VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const HOST = "127.0.0.1";
const PORT = Number(process.env.CONTROL_DECK_DASHBOARD_PORT || 50712);
// Where this checkout lives, so the dashboard's Connect page can render exact
// copy-paste MCP configuration for this machine.
const INSTALL_PATH = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// The bridge client is TypeScript and ships compiled in dist/. The service
// still starts (and reports "waiting") when the project has not been built or
// setup has not generated the bridge token yet.
let client = null;
let clientError = null;
try {
  const { AbletonClient } = await import("../dist/src/ableton-client.js");
  client = new AbletonClient({ timeoutMs: 1400 });
} catch (error) {
  clientError = error.message;
}

let activeIndexBuild = null;

function corsHeaders(origin) {
  const allowed = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  return {
    "access-control-allow-origin": allowed && origin ? origin : "http://127.0.0.1:3000",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin"
  };
}

function sendJson(response, status, payload, origin) {
  response.writeHead(status, {
    ...corsHeaders(origin),
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function query(address, args = []) {
  const reply = await client.query(address, args);
  return reply.args;
}

async function bridgeSnapshot() {
  if (!client) {
    return { state: "waiting", status: null, tracks: null, devices: null, message: clientError };
  }
  try {
    const status = await client.status();
    const [tempo] = await query("/live/song/get/tempo");
    const [playing] = await query("/live/song/get/is_playing");
    const [recording] = await query("/live/song/get/record_mode");
    const [metronome] = await query("/live/song/get/metronome");
    const trackNames = await query("/live/song/get/track_names");
    const tracks = { total: trackNames.length, tracks: trackNames.map((name, index) => ({ index, name })) };

    let selectedTrack = null;
    let devices = null;
    try {
      const [selectedIndex] = await query("/live/view/get/selected_track");
      selectedTrack = { index: selectedIndex, name: trackNames[selectedIndex] ?? `Track ${selectedIndex + 1}` };
      const deviceNames = (await query("/live/track/get/devices/name", [selectedIndex])).slice(1);
      const deviceClasses = (await query("/live/track/get/devices/class_name", [selectedIndex])).slice(1);
      devices = {
        total: deviceNames.length,
        devices: deviceNames.map((name, index) => ({
          index,
          name,
          type: deviceClasses[index] ?? "Device",
          plugin: /plugin/i.test(String(deviceClasses[index] ?? ""))
        }))
      };
    } catch {
      // The selection can be a return/master track the bridge does not expose.
    }

    return {
      state: "online",
      status: {
        liveVersion: status.liveVersion ?? null,
        transport: {
          playing: Boolean(playing),
          recording: Boolean(recording),
          metronome: Boolean(metronome),
          tempo: Number(tempo),
          tempoDisplay: `${Number(tempo).toFixed(2).replace(/\.00$/, "")} BPM`
        },
        selectedTrack,
        bridgePluginCount: status.pluginCount ?? null,
        bridgeCacheBuiltAt: status.cacheBuiltAt ?? null
      },
      tracks,
      devices,
      message: "Control Deck Bridge is connected to Ableton Live."
    };
  } catch (error) {
    return {
      state: "waiting",
      status: null,
      tracks: null,
      devices: null,
      message: "Control Deck Bridge is installed. Open Ableton Live and enable the Control Deck Control Surface to activate it.",
      detail: error.message
    };
  }
}

async function snapshot() {
  const [bridge, index] = await Promise.all([bridgeSnapshot(), readPluginIndex()]);
  return {
    service: { state: "online", name: "Control Deck Local Service", version: SERVICE_VERSION, localOnly: true, installPath: INSTALL_PATH },
    bridge,
    library: {
      generatedAt: index.generatedAt,
      uniquePlugins: index.uniquePlugins,
      pluginBundles: index.pluginBundles,
      formatCounts: index.formatCounts
    }
  };
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }

  try {
    const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "Control Deck Local Service", installPath: INSTALL_PATH }, origin);
      return;
    }
    if (request.method === "GET" && url.pathname === "/snapshot") {
      sendJson(response, 200, await snapshot(), origin);
      return;
    }
    if (request.method === "GET" && url.pathname === "/plugins") {
      const index = await readPluginIndex();
      sendJson(response, 200, searchPluginIndex(index, {
        query: url.searchParams.get("query") || "",
        format: url.searchParams.get("format") || "all",
        offset: url.searchParams.get("offset") || 0,
        limit: url.searchParams.get("limit") || 80
      }), origin);
      return;
    }
    if (request.method === "POST" && url.pathname === "/plugins/reindex") {
      activeIndexBuild ||= buildPluginIndex().finally(() => { activeIndexBuild = null; });
      const index = await activeIndexBuild;
      sendJson(response, 200, {
        ok: true,
        generatedAt: index.generatedAt,
        uniquePlugins: index.uniquePlugins,
        pluginBundles: index.pluginBundles,
        formatCounts: index.formatCounts
      }, origin);
      return;
    }
    sendJson(response, 404, { ok: false, message: "Not found" }, origin);
  } catch (error) {
    sendJson(response, 500, { ok: false, message: error.message }, origin);
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Control Deck Local Service listening at http://${HOST}:${PORT}`);
  try {
    const index = await readPluginIndex();
    console.log(`Control Deck indexed ${index.uniquePlugins} unique plug-ins.`);
  } catch (error) {
    console.error(`Control Deck plug-in index error: ${error.message}`);
  }
});

function shutdown() {
  if (client) client.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
