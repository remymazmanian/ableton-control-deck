"use strict";

const dgram = require("node:dgram");
const Max = require("max-api");

const PROTOCOL = "control-deck-omnihost/1";
const HOST = "127.0.0.1";
const PORT = Number(process.env.CONTROL_DECK_OMNIHOST_PORT || 50714);
const PLUGIN_NAME = "Mini V4";
const MAX_PAGE_SIZE = 250;
const QUERY_TIMEOUT_MS = 1500;
const AUTO_REFRESH_DELAY_MS = 2500;
const AUTO_REFRESH_INTERVAL_MS = 4000;
const AUTO_REFRESH_MAX_ATTEMPTS = 8;

let expectedParameterCount = 0;
let parameterNames = [];
let catalogReady = false;
let startedAt = new Date().toISOString();
let lastError = null;
let querySequence = 0;
let autoRefreshAttempts = 0;
let autoRefreshTimer = null;
const values = new Map();
const pendingQueries = new Map();

function cancelAutoRefresh() {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  autoRefreshTimer = null;
}

function markCatalogReady() {
  parameterNames = parameterNames.slice(0, expectedParameterCount);
  catalogReady = true;
  lastError = null;
  cancelAutoRefresh();
  const useful = parameterNames.filter(name => !isHelperParameter(name)).length;
  Max.outlet("ui_status", `Ready · ${expectedParameterCount} indexed · ${useful} useful`);
}

function scheduleAutoRefresh(delayMs = AUTO_REFRESH_INTERVAL_MS) {
  if (catalogReady) return cancelAutoRefresh();
  cancelAutoRefresh();
  autoRefreshTimer = setTimeout(() => {
    autoRefreshTimer = null;
    if (catalogReady) return;
    if (autoRefreshAttempts >= AUTO_REFRESH_MAX_ATTEMPTS) {
      lastError = "Mini V4 did not publish its parameter catalog after automatic retries.";
      Max.outlet("ui_status", "Indexing paused · press Refresh Map to retry");
      return;
    }
    autoRefreshAttempts += 1;
    Max.outlet("refresh_catalog");
    scheduleAutoRefresh();
  }, delayMs);
}

function isHelperParameter(name) {
  return /^MIDI CC helper\b/i.test(name);
}

function parameterAt(index) {
  if (!Number.isInteger(index) || index < 1 || index > parameterNames.length) return null;
  const name = parameterNames[index - 1];
  return { index, name, helper: isHelperParameter(name) };
}

function requireParameter(params) {
  const index = Number(params.parameterIndex);
  const parameter = parameterAt(index);
  if (!parameter) throw requestError("PARAMETER_NOT_FOUND", `Mini V4 parameter index ${params.parameterIndex} does not exist.`);
  if (typeof params.expectedParameterName !== "string" || params.expectedParameterName !== parameter.name) {
    throw requestError("PARAMETER_IDENTITY_CHANGED", `Expected '${params.expectedParameterName}', found '${parameter.name}' at index ${index}.`);
  }
  if (params.expectedPluginName && params.expectedPluginName !== PLUGIN_NAME) {
    throw requestError("PLUGIN_IDENTITY_CHANGED", `Expected '${params.expectedPluginName}', found '${PLUGIN_NAME}'.`);
  }
  return parameter;
}

function requestError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeAddress(address) {
  return address === "::ffff:127.0.0.1" ? "127.0.0.1" : address;
}

function sendReply(server, remote, request, ok, payload) {
  const body = ok
    ? { protocol: PROTOCOL, id: request.id, ok: true, result: payload }
    : { protocol: PROTOCOL, id: request.id, ok: false, error: payload };
  const data = Buffer.from(JSON.stringify(body), "utf8");
  server.send(data, remote.port, remote.address);
}

function status() {
  const usefulCount = parameterNames.reduce((count, name) => count + (isHelperParameter(name) ? 0 : 1), 0);
  return {
    connected: true,
    protocol: PROTOCOL,
    host: HOST,
    port: PORT,
    pluginName: PLUGIN_NAME,
    pluginFormat: "vst3",
    pluginPath: "/Library/Audio/Plug-Ins/VST3/Mini V4.vst3",
    catalogReady,
    parameterCount: expectedParameterCount || parameterNames.length,
    indexedParameterCount: parameterNames.length,
    usefulParameterCount: usefulCount,
    helperParameterCount: parameterNames.length - usefulCount,
    startedAt,
    lastError
  };
}

function listParameters(params) {
  if (!catalogReady) throw requestError("CATALOG_NOT_READY", "Mini V4 is still being indexed. Try again in a moment.");
  const query = String(params.query || "").trim().toLocaleLowerCase();
  const includeHelpers = params.includeHelpers === true;
  const offset = Math.max(0, Number.isInteger(params.offset) ? params.offset : 0);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isInteger(params.limit) ? params.limit : 100));
  const matches = [];
  for (let index = 1; index <= parameterNames.length; index += 1) {
    const parameter = parameterAt(index);
    if (!parameter || (!includeHelpers && parameter.helper)) continue;
    if (query && !parameter.name.toLocaleLowerCase().includes(query)) continue;
    matches.push(parameter);
  }
  return {
    pluginName: PLUGIN_NAME,
    query,
    includeHelpers,
    matched: matches.length,
    returned: matches.slice(offset, offset + limit).length,
    offset,
    limit,
    truncated: offset + limit < matches.length,
    parameters: matches.slice(offset, offset + limit)
  };
}

function queryParameter(index) {
  return new Promise((resolve, reject) => {
    const token = ++querySequence;
    const timer = setTimeout(() => {
      const pending = pendingQueries.get(index) || [];
      pendingQueries.set(index, pending.filter(entry => entry.token !== token));
      reject(requestError("PARAMETER_TIMEOUT", `Timed out reading Mini V4 parameter ${index}.`));
    }, QUERY_TIMEOUT_MS);
    const pending = pendingQueries.get(index) || [];
    pending.push({ token, resolve, reject, timer });
    pendingQueries.set(index, pending);
    Max.outlet("get_param", index);
  });
}

function settleParameter(index, normalizedValue, displayValue) {
  const value = { normalizedValue, displayValue: displayValue || String(normalizedValue) };
  values.set(index, value);
  const pending = pendingQueries.get(index) || [];
  pendingQueries.delete(index);
  for (const entry of pending) {
    clearTimeout(entry.timer);
    entry.resolve(value);
  }
}

async function handleRequest(request) {
  if (!request || request.protocol !== PROTOCOL || typeof request.id !== "string" || typeof request.method !== "string") {
    throw requestError("INVALID_REQUEST", `Expected protocol '${PROTOCOL}' with string id and method.`);
  }
  const params = request.params && typeof request.params === "object" ? request.params : {};
  switch (request.method) {
    case "omnihost.status":
      return status();
    case "omnihost.list_parameters":
      return listParameters(params);
    case "omnihost.get_parameter": { 
      const parameter = requireParameter(params);
      const value = await queryParameter(parameter.index);
      return { pluginName: PLUGIN_NAME, ...parameter, ...value };
    }
    case "omnihost.set_parameter": {
      const parameter = requireParameter(params);
      const requested = Number(params.normalizedValue);
      if (!Number.isFinite(requested) || requested < 0 || requested > 1) {
        throw requestError("INVALID_VALUE", "normalizedValue must be between 0 and 1.");
      }
      const previous = await queryParameter(parameter.index);
      Max.outlet("set_param", parameter.index, requested);
      await new Promise(resolve => setTimeout(resolve, 35));
      const actual = await queryParameter(parameter.index);
      return {
        pluginName: PLUGIN_NAME,
        ...parameter,
        previousNormalizedValue: previous.normalizedValue,
        previousDisplayValue: previous.displayValue,
        requestedNormalizedValue: requested,
        normalizedValue: actual.normalizedValue,
        displayValue: actual.displayValue
      };
    }
    case "omnihost.open_editor":
      Max.outlet("open_plugin");
      return { pluginName: PLUGIN_NAME, opened: true };
    case "omnihost.refresh_catalog":
      catalogReady = false;
      expectedParameterCount = 0;
      parameterNames = [];
      autoRefreshAttempts = 0;
      Max.outlet("refresh_catalog");
      scheduleAutoRefresh();
      return { pluginName: PLUGIN_NAME, refreshStarted: true };
    default:
      throw requestError("METHOD_NOT_FOUND", `Unknown OmniHost method '${request.method}'.`);
  }
}

Max.addHandler("catalog_reset", () => {
  catalogReady = false;
  expectedParameterCount = 0;
  parameterNames = [];
  Max.outlet("ui_status", "Indexing Mini V4 parameters…");
  scheduleAutoRefresh();
});

Max.addHandler("device_ready", () => {
  Max.outlet("ui_status", "Starting Control Deck OmniHost…");
});

Max.addHandler("param_name", (...atoms) => {
  const name = atoms.map(String).join(" ").trim();
  if (!name) return;
  parameterNames.push(name);
  if (expectedParameterCount > 0 && parameterNames.length >= expectedParameterCount) {
    markCatalogReady();
  }
});

Max.addHandler("plugin_info", (...atoms) => {
  const index = Number(atoms[0]);
  if (!Number.isFinite(index)) return;
  if (index === -4) {
    expectedParameterCount = Number(atoms[1]) || 0;
    if (expectedParameterCount > 0 && parameterNames.length >= expectedParameterCount) {
      markCatalogReady();
    }
    return;
  }
  if (index < 1) return;
  const normalizedValue = Number(atoms[1]);
  if (!Number.isFinite(normalizedValue)) return;
  const displayValue = atoms.slice(2).map(String).join(" ");
  settleParameter(index, normalizedValue, displayValue);
});

const server = dgram.createSocket("udp4");
server.on("message", async (message, remote) => {
  let request = { id: "unknown" };
  try {
    if (normalizeAddress(remote.address) !== HOST) throw requestError("LOCALHOST_ONLY", "Control Deck OmniHost accepts localhost requests only.");
    request = JSON.parse(message.toString("utf8"));
    const result = await handleRequest(request);
    sendReply(server, remote, request, true, result);
  } catch (error) {
    const code = error && error.code ? error.code : "OMNIHOST_ERROR";
    const messageText = error instanceof Error ? error.message : String(error);
    lastError = messageText;
    sendReply(server, remote, request, false, { code, message: messageText, details: error && error.details });
  }
});
server.on("error", error => {
  lastError = error.message;
  Max.post(`Control Deck OmniHost UDP error: ${error.message}`, Max.POST_LEVELS.ERROR);
  Max.outlet("ui_status", `Controller unavailable · ${error.message}`);
});
server.bind(PORT, HOST, () => {
  Max.post(`Control Deck OmniHost listening on ${HOST}:${PORT}`);
  Max.outlet("ui_status", "Controller online · indexing Mini V4…");
  scheduleAutoRefresh(AUTO_REFRESH_DELAY_MS);
});

function shutdown() {
  cancelAutoRefresh();
  for (const pending of pendingQueries.values()) {
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(requestError("OMNIHOST_STOPPED", "Control Deck OmniHost stopped."));
    }
  }
  pendingQueries.clear();
  try { server.close(); } catch {}
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
