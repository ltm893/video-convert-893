"use strict";

export const VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "mpeg", "mpg", "avi", "mkv", "wmv"]);
export const AUDIO_EXTS = new Set(["aiff", "aif", "wav", "flac", "m4a", "aac", "ogg", "wma", "mp3"]);
export const DISC_EXTS = new Set([
  ...VIDEO_EXTS,
  ...AUDIO_EXTS,
  "vob", "ifo", "bup", "dat", "vro", "m2ts", "mts",
]);

export function slugName(raw, fallback = "disc") {
  const text = String(raw || "").split(/[/\\]/).pop() || "";
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || fallback;
}

export function parseOwnedKey(userId, raw) {
  const key = String(raw || "").replace(/^\/+/, "");
  const parts = key.split("/");
  if (parts.length < 4 || parts[0] !== "incoming" || parts[1] !== userId || !parts[2]) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  if (parts.some((p) => p === "." || p === ".." || !p)) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  if (parts.length > 12) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  return {
    key,
    jobId: parts[2],
    filename: parts[parts.length - 1],
    prefix: `incoming/${userId}/${parts[2]}/`,
  };
}

export function safeRelPath(raw) {
  const parts = String(raw || "").replace(/\\/g, "/").split("/").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) {
    const err = new Error("invalid disc path");
    err.statusCode = 400;
    throw err;
  }
  const out = [];
  for (const part of parts) {
    if (part === "." || part === "..") {
      const err = new Error("invalid disc path");
      err.statusCode = 400;
      throw err;
    }
    const cleaned = part.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
    if (!cleaned || cleaned === "." || cleaned === "..") {
      const err = new Error("invalid disc path");
      err.statusCode = 400;
      throw err;
    }
    out.push(cleaned.slice(0, 80));
  }
  const ext = extensionOf(out[out.length - 1]);
  if (!DISC_EXTS.has(ext)) {
    const err = new Error("That folder has a file type the converter does not use.");
    err.statusCode = 400;
    throw err;
  }
  return out.join("/");
}

export function extensionOf(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function isJobId(value) {
  return /^[A-Za-z0-9-]{8,128}$/.test(String(value || "").trim());
}

export function ownedUserFileKey(userId, raw) {
  const key = String(raw || "").replace(/^\/+/, "");
  const prefix = `users/${userId}/`;
  if (!key || key.endsWith("/") || !key.startsWith(prefix)) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  const parts = key.split("/");
  if (parts.some((p) => p === "." || p === ".." || !p) || parts.length < 3 || parts.length > 16) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  return key;
}

export function ownedUserPrefix(userId, raw) {
  const key = String(raw || "").replace(/^\/+/, "");
  const prefix = key.endsWith("/") ? key : `${key}/`;
  const root = `users/${userId}/`;
  if (!prefix.startsWith(root) || prefix.includes("..")) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  const parts = prefix.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..") || parts.length < 4 || parts.length > 16) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  const libraries = [`${root}Music/`, `${root}Videos/`, `${root}Photos/`];
  if (libraries.includes(prefix) || (!prefix.startsWith(`${root}Music/`) && !prefix.startsWith(`${root}Videos/`))) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  return prefix;
}

export function replaceOutputKey(outputKeys, fromKey, destKey) {
  let changed = false;
  const from = String(fromKey || "");
  const dest = String(destKey || "");
  const fromName = from.split("/").pop() || "";
  const fromDir = fromName ? from.slice(0, from.length - fromName.length) : "";
  const next = (Array.isArray(outputKeys) ? outputKeys : []).map((key) => {
    const k = String(key || "");
    if (k === from || (fromName && k === `${fromDir}${fromName}`)) {
      changed = true;
      return dest;
    }
    return key;
  });
  return { changed, outputKeys: next };
}

export function replaceOutputPrefix(outputKeys, fromPrefix, destPrefix) {
  let changed = false;
  const from = String(fromPrefix || "").endsWith("/") ? String(fromPrefix) : `${fromPrefix}/`;
  const dest = String(destPrefix || "").endsWith("/") ? String(destPrefix) : `${destPrefix}/`;
  const next = (Array.isArray(outputKeys) ? outputKeys : []).map((key) => {
    const k = String(key || "");
    if (k.startsWith(from)) {
      changed = true;
      return `${dest}${k.slice(from.length)}`;
    }
    return key;
  });
  return { changed, outputKeys: next };
}

function remapStoredPrefix(prefix, fromPrefix, destPrefix) {
  const stored = String(prefix || "");
  const from = String(fromPrefix || "").endsWith("/") ? String(fromPrefix) : `${fromPrefix}/`;
  const dest = String(destPrefix || "").endsWith("/") ? String(destPrefix) : `${destPrefix}/`;
  if (!stored) return { changed: false, outputPrefix: stored };
  const norm = stored.endsWith("/") ? stored : `${stored}/`;
  if (norm === from) return { changed: true, outputPrefix: dest };
  if (norm.startsWith(from)) return { changed: true, outputPrefix: `${dest}${norm.slice(from.length)}` };
  return { changed: false, outputPrefix: stored };
}

export function remapJobOutput(item, fromKey, destKey) {
  const from = String(fromKey || "");
  const dest = String(destKey || "");
  if (from.endsWith("/") || dest.endsWith("/")) {
    const keys = replaceOutputPrefix(item?.outputKeys, from, dest);
    const prefix = remapStoredPrefix(item?.outputPrefix, from, dest);
    return {
      changed: keys.changed || prefix.changed,
      outputKeys: keys.outputKeys,
      outputPrefix: prefix.outputPrefix,
    };
  }
  const first = replaceOutputKey(item?.outputKeys, from, dest);
  if (first.changed) return { ...first, outputPrefix: item?.outputPrefix || "" };
  const fromName = from.split("/").pop() || "";
  const fromStem = fromName.replace(/\.[^.]+$/, "");
  const filename = String(item?.filename || "");
  const disc = String(item?.disc || "");
  const nameHit = filename === fromName || filename === fromStem || disc === fromName || disc === fromStem;
  const keys = jobOutputKeys(item);
  if (nameHit && keys.length <= 1) {
    return { changed: true, outputKeys: dest ? [dest] : [], outputPrefix: item?.outputPrefix || "" };
  }
  return { ...first, outputPrefix: item?.outputPrefix || "" };
}

export function jobOutputKeys(item) {
  return (Array.isArray(item?.outputKeys) ? item.outputKeys : []).filter(Boolean);
}

export function ingestPrefixForJob(userId, item) {
  const jobId = String(item?.jobId || "").trim();
  const fallback = isJobId(jobId) ? `incoming/${userId}/${jobId}/` : "";
  const prefix = String(item?.ingestKey || fallback);
  const want = `incoming/${userId}/`;
  if (!prefix.startsWith(want) || prefix.includes("..")) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export function jobMatchesDeletedFile(item, userId, key) {
  const owned = ownedUserFileKey(userId, key);
  const keys = jobOutputKeys(item);
  if (keys.includes(owned)) return true;
  const libraryPrefixes = [`users/${userId}/Videos/`, `users/${userId}/Music/`];
  const filename = String(item?.filename || "");
  const disc = String(item?.disc || "");
  for (const libraryPrefix of libraryPrefixes) {
    if (!owned.startsWith(libraryPrefix)) continue;
    const name = owned.slice(libraryPrefix.length);
    const stem = name.replace(/\.[^.]+$/, "");
    if (filename === name || filename === stem || disc === stem || disc === name) return true;
  }
  return false;
}

export function removeDeletedOutput(item, userId, key) {
  const owned = ownedUserFileKey(userId, key);
  if (!jobMatchesDeletedFile(item, userId, owned)) {
    return { matched: false, outputKeys: jobOutputKeys(item), empty: false };
  }
  const keys = jobOutputKeys(item);
  const next = keys.filter((output) => output !== owned);
  if (keys.length && next.length === keys.length) {
    return { matched: true, outputKeys: [], empty: true };
  }
  return { matched: true, outputKeys: next, empty: next.length === 0 };
}

export function cdDateStamp(now = new Date(), timeZone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";
  return `${year}${month}${day}`;
}

export function nextCdAlbumPrefix(musicRoot, existingPrefixes = [], now = new Date()) {
  const root = String(musicRoot || "").endsWith("/") ? String(musicRoot) : `${musicRoot}/`;
  const stamp = cdDateStamp(now);
  const re = new RegExp(`^CD${stamp}-(\\d+)$`);
  let max = 0;
  for (const raw of existingPrefixes || []) {
    const text = String(raw || "");
    let name = "";
    if (!text.includes("/")) name = text;
    else if (text.startsWith(root)) name = text.slice(root.length).split("/").filter(Boolean)[0] || "";
    else continue;
    const match = name.match(re);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${root}CD${stamp}-${max + 1}/`;
}

export function jobNameKey(item) {
  const name = String(item?.filename || item?.disc || "").trim().toLowerCase();
  const stem = name.replace(/\.(mp4|m4v|mov|mpeg|mpg|avi|mkv|wmv|mp3|aiff|aif|wav|flac|m4a)$/i, "");
  return stem || name;
}

function jobRecordId(item) {
  return item?.jobId || String(item?.pk || "").replace(/^JOB#/, "");
}

function jobRecordTime(item) {
  return Date.parse(item?.createdAt || "") || Date.parse(item?.updatedAt || "") || 0;
}

function isActiveJob(item) {
  const status = String(item?.status || "");
  return status === "UPLOADING" || status === "QUEUED" || status === "CONVERTING";
}

export function jobsToSupersede(items) {
  const rows = Array.isArray(items) ? items : [];
  const activeNames = new Set(rows.filter(isActiveJob).map(jobNameKey).filter(Boolean));
  const keep = new Map();
  for (const item of rows) {
    const key = jobNameKey(item);
    if (!key || activeNames.has(key) || String(item?.status || "") !== "READY") continue;
    const prev = keep.get(key);
    const newer = !prev
      || jobRecordTime(item) > jobRecordTime(prev)
      || (jobRecordTime(item) === jobRecordTime(prev) && jobRecordId(item) > jobRecordId(prev));
    if (newer) keep.set(key, item);
  }
  return rows.filter((item) => {
    const key = jobNameKey(item);
    const keeper = keep.get(key);
    if (!key || !keeper || activeNames.has(key)) return false;
    if (jobRecordId(item) === jobRecordId(keeper)) return false;
    return !isActiveJob(item);
  });
}

const MAX_EDIT_SECONDS = 24 * 60 * 60;
const MAX_COMBINE_SOURCES = 20;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  throw err;
}

export function parseMediaTimestamp(raw) {
  const text = String(raw ?? "").trim();
  if (!text) badRequest("Enter a start and end time.");
  if (text.startsWith("-")) badRequest("That time is out of range.");
  let seconds;
  if (/^\d+(\.\d+)?$/.test(text)) {
    seconds = Number(text);
  } else {
    const parts = text.split(":");
    if (parts.length < 2 || parts.length > 3) badRequest("Use a time like 1:30 or 1:02:15.");
    const sec = parts[parts.length - 1];
    const heads = parts.slice(0, -1);
    if (!/^\d+(\.\d+)?$/.test(sec) || heads.some((part) => !/^\d+$/.test(part))) {
      badRequest("Use a time like 1:30 or 1:02:15.");
    }
    if (Number(sec) >= 60) badRequest("Use a time like 1:30 or 1:02:15.");
    if (parts.length === 3 && Number(parts[1]) >= 60) badRequest("Use a time like 1:30 or 1:02:15.");
    const nums = parts.map(Number);
    seconds = parts.length === 2
      ? nums[0] * 60 + nums[1]
      : nums[0] * 3600 + nums[1] * 60 + nums[2];
  }
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_EDIT_SECONDS) {
    badRequest("That time is out of range.");
  }
  return Math.round(seconds * 1000) / 1000;
}

export function formatMediaTimestamp(seconds) {
  const totalMs = Math.round(Number(seconds) * 1000);
  const ms = ((totalMs % 1000) + 1000) % 1000;
  const total = Math.floor(totalMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const frac = ms ? `.${String(ms).padStart(3, "0").replace(/0+$/, "")}` : "";
  return `${h}:${pad(m)}:${pad(s)}${frac}`;
}

export function ownedMineVideoKey(userId, raw) {
  const key = ownedUserFileKey(userId, raw);
  const root = `users/${userId}/Videos/`;
  if (!key.startsWith(root)) badRequest("Choose an MP4 in Mine → Videos.");
  const ext = extensionOf(key);
  if (ext !== "mp4" && ext !== "m4v") badRequest("Choose an MP4.");
  return key;
}

export function editOutputFilename(raw, fallback = "") {
  const typed = String(raw || "").trim() || String(fallback || "").trim();
  const name = slugName(typed, "").replace(/\.(mp4|m4v)$/i, "");
  if (!name) badRequest("Enter a file name.");
  return `${name.slice(0, 160)}.mp4`;
}

export function buildEditPlan(userId, body) {
  const kind = String(body?.kind || "").trim();
  if (kind !== "clip" && kind !== "combine") badRequest("Choose clip or combine.");
  const rawKeys = kind === "clip"
    ? [body?.sourceKey || body?.key]
    : (Array.isArray(body?.sourceKeys) ? body.sourceKeys : []);
  if (kind === "combine" && rawKeys.length < 2) badRequest("Choose at least two MP4s.");
  if (rawKeys.length > MAX_COMBINE_SOURCES) badRequest("Combine up to 20 MP4s.");
  const sourceKeys = [];
  for (const raw of rawKeys) {
    const key = ownedMineVideoKey(userId, raw);
    if (sourceKeys.includes(key)) badRequest("That MP4 is already in the list.");
    sourceKeys.push(key);
  }
  let clipStart = "";
  let clipEnd = "";
  if (kind === "clip") {
    const start = parseMediaTimestamp(body?.start);
    const end = parseMediaTimestamp(body?.end);
    if (!(end > start)) badRequest("End time has to be after the start time.");
    clipStart = formatMediaTimestamp(start);
    clipEnd = formatMediaTimestamp(end);
  }
  const sourceName = sourceKeys[0].split("/").pop().replace(/\.(mp4|m4v)$/i, "");
  const fallback = kind === "clip" ? `${sourceName}-clip` : `${sourceName}-combined`;
  const filename = editOutputFilename(body?.name || body?.filename, fallback);
  const folders = sourceKeys.map((key) => key.slice(0, key.lastIndexOf("/") + 1));
  const outputPrefix = folders.every((folder) => folder === folders[0])
    ? folders[0]
    : `users/${userId}/Videos/`;
  const outputKey = `${outputPrefix}${filename}`;
  if (sourceKeys.includes(outputKey)) badRequest("Choose a new file name.");
  return { kind, sourceKeys, clipStart, clipEnd, filename, outputPrefix, outputKey };
}

export function jobTouchesPrefix(item, userId, prefix) {
  const root = `users/${userId}/`;
  const norm = String(prefix || "").endsWith("/") ? String(prefix) : `${prefix}/`;
  if (!norm.startsWith(root) || norm.includes("..")) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  return jobOutputKeys(item).some((key) => String(key).startsWith(norm));
}
