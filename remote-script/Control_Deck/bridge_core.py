"""Pure protocol helpers for Control Deck Bridge. This module has no Ableton imports."""

SUPPORTED_FORMATS = ("vst3", "vst2", "au", "auv2")


class BridgeError(Exception):
    def __init__(self, code, message, details=None):
        super(BridgeError, self).__init__(message)
        self.code = code
        self.message = message
        self.details = details


def clean_text(value, field="value", max_length=1024):
    text = str(value or "").replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
    if not text:
        raise BridgeError("INVALID_REQUEST", "%s must not be empty" % field)
    if len(text) > max_length:
        raise BridgeError("INVALID_REQUEST", "%s exceeds %d characters" % (field, max_length))
    return text


def normalize_path(value):
    text = clean_text(value, "path", 4096).replace("\\", "/")
    while "//" in text:
        text = text.replace("//", "/")
    return text.rstrip("/")


def normalize_format(value, optional=False):
    text = str(value or "").strip().lower()
    aliases = {"vst": "vst2", "audio_unit": "au", "audio-unit": "au", "audio unit": "au"}
    text = aliases.get(text, text)
    if optional and not text:
        return None
    if text not in SUPPORTED_FORMATS:
        raise BridgeError("INVALID_FORMAT", "format must be one of: %s" % ", ".join(SUPPORTED_FORMATS))
    return text


def format_from_path(path):
    segments = [segment.strip().lower() for segment in normalize_path(path).split("/")]
    normalized = [segment.replace("-", " ").replace("_", " ") for segment in segments]
    if any(segment in ("vst3", "vst 3", "vst3 plugins", "vst3 plug ins") for segment in normalized):
        return "vst3"
    if any(segment in ("vst", "vst2", "vst 2", "vst plugins", "vst plug ins") for segment in normalized):
        return "vst2"
    if any(segment in ("auv2", "au v2", "audio units v2", "audio unit v2") for segment in normalized):
        return "auv2"
    if any(segment in ("au", "audio units", "audio unit") for segment in normalized):
        return "au"
    return None


def public_plugin(entry):
    return {"name": entry["name"], "path": entry["path"], "format": entry["format"]}


def filter_plugins(entries, query=None, plugin_format=None, limit=100, offset=0):
    fmt = normalize_format(plugin_format, optional=True)
    query_text = str(query or "").strip().casefold()
    try:
        limit_value = max(1, min(int(limit), 500))
        offset_value = max(0, int(offset))
    except Exception:
        raise BridgeError("INVALID_REQUEST", "limit and offset must be integers")

    matches = []
    for entry in entries:
        if fmt and entry.get("format") != fmt:
            continue
        if query_text and query_text not in entry.get("name", "").casefold() and query_text not in entry.get("path", "").casefold():
            continue
        matches.append(entry)
    matches.sort(key=lambda item: (item.get("name", "").casefold(), item.get("path", "").casefold()))
    page = matches[offset_value:offset_value + limit_value]
    return {
        "plugins": [public_plugin(entry) for entry in page],
        "returned": len(page),
        "matched": len(matches),
        "offset": offset_value,
        "limit": limit_value,
        "truncated": offset_value + len(page) < len(matches),
    }


def resolve_plugin(entries, name, plugin_format, expected_path=None):
    target_name = clean_text(name, "name").casefold()
    fmt = normalize_format(plugin_format)
    candidates = [entry for entry in entries if entry.get("format") == fmt]

    if expected_path:
        target_path = normalize_path(expected_path).casefold()
        path_matches = [entry for entry in candidates if normalize_path(entry.get("path", "")).casefold() == target_path]
        if not path_matches:
            raise BridgeError("PLUGIN_NOT_FOUND", "No %s plugin exists at the requested path" % fmt, {"path": expected_path})
        entry = path_matches[0]
        if entry.get("name", "").casefold() != target_name:
            raise BridgeError("PLUGIN_IDENTITY_MISMATCH", "Plugin name does not match the exact browser path", {"requestedName": name, "plugin": public_plugin(entry)})
        return entry

    exact = [entry for entry in candidates if entry.get("name", "").casefold() == target_name]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise BridgeError("AMBIGUOUS_PLUGIN", "Multiple exact plugin names match; provide an exact path", {"candidates": [public_plugin(entry) for entry in exact[:20]]})

    partial = [entry for entry in candidates if target_name in entry.get("name", "").casefold()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        raise BridgeError("AMBIGUOUS_PLUGIN", "Multiple plugins match; use the exact name or path", {"candidates": [public_plugin(entry) for entry in partial[:20]]})
    raise BridgeError("PLUGIN_NOT_FOUND", "No %s plugin matched '%s'" % (fmt, name))
