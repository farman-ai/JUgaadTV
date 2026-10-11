import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const onVercel = Boolean(process.env.VERCEL);
const PLAYLIST_URL = "https://iptv-org.github.io/iptv/index.m3u";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const loginAttempts = new Map();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";
let playlistCache = { channels: null, expiresAt: 0 };
const streamTargets = new Map();
const publicHostCache = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function findUnquotedComma(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === "," && !quoted) return index;
  }
  return -1;
}

function parseM3U(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#EXTINF:")) {
      const commaIndex = findUnquotedComma(line);
      const attributes = commaIndex >= 0 ? line.slice(0, commaIndex) : line;
      const name = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : "Untitled channel";
      const metadata = {};
      const attributePattern = /([\w-]+)="([^"]*)"/g;
      let match;
      while ((match = attributePattern.exec(attributes)) !== null) {
        metadata[match[1].toLowerCase()] = match[2];
      }
      pending = { name: name || "Untitled channel", metadata };
      continue;
    }

    if (!line || line.startsWith("#") || !pending) continue;
    let url;
    try {
      url = new URL(line);
    } catch {
      pending = null;
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      pending = null;
      continue;
    }

    const metadata = pending.metadata;
    const name = pending.name;
    const category = metadata["group-title"] || "Uncategorized";
    channels.push({
      id: `${slugify(metadata["tvg-id"] || name) || "channel"}-${channels.length}`,
      name,
      url: url.href,
      logo: metadata["tvg-logo"] || "",
      country: (metadata["tvg-country"] || "Unknown").split(";")[0].trim().toUpperCase(),
      language: metadata["tvg-language"] || "Unknown",
      category,
      source: metadata["tvg-id"] || "IPTV"
    });
    pending = null;
  }
  return channels;
}

async function getChannels(forceRefresh = false) {
  if (!forceRefresh && playlistCache.channels && playlistCache.expiresAt > Date.now()) {
    return playlistCache.channels;
  }

  const response = await fetch(PLAYLIST_URL, {
    signal: AbortSignal.timeout(25_000),
    headers: { "User-Agent": "JUGAADTV/1.0 (local IPTV player)" }
  });
  if (!response.ok) {
    throw new Error(`Playlist source returned HTTP ${response.status}`);
  }
  const channels = parseM3U(await response.text());
  if (!channels.length) {
    throw new Error("Playlist source did not contain any valid HTTP(S) channels");
  }
  playlistCache = { channels, expiresAt: Date.now() + 15 * 60 * 1000 };
  return channels;
}

function isPublicIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return !(
    first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && parts[2] === 113)
  );
}

function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mappedIPv4 = normalized.slice(7);
    return isIP(mappedIPv4) === 4 && isPublicIPv4(mappedIPv4);
  }
  return normalized !== "::" && normalized !== "::1" &&
    !/^f[cd]/.test(normalized) && !/^fe[89ab]/.test(normalized) &&
    !normalized.startsWith("ff") && !normalized.startsWith("2001:db8:");
}

async function assertPublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid stream URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) {
    throw new Error("Stream URL is not publicly accessible");
  }

  let addresses;
  if (isIP(url.hostname)) {
    addresses = [{ address: url.hostname }];
  } else {
    const cacheEntry = publicHostCache.get(url.hostname);
    if (cacheEntry && cacheEntry.expiresAt > Date.now()) {
      addresses = cacheEntry.addresses;
    } else {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
      publicHostCache.set(url.hostname, { addresses, expiresAt: Date.now() + 5 * 60 * 1000 });
    }
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Stream host is not publicly accessible");
  }
  return url;
}

function getStreamTargets(channelId) {
  let targets = streamTargets.get(channelId);
  if (!targets) {
    targets = new Set();
    streamTargets.set(channelId, targets);
  }
  return targets;
}

function rememberStreamTarget(targets, url) {
  targets.add(url);
  while (targets.size > 1500) {
    targets.delete(targets.values().next().value);
  }
}

function signValue(value, secret) {
  const encoded = Buffer.from(value).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySignedValue(token, secret) {
  if (typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const encoded = token.slice(0, separator);
  const suppliedSignature = Buffer.from(token.slice(separator + 1), "base64url");
  const expectedSignature = Buffer.from(
    crypto.createHmac("sha256", secret).update(encoded).digest("base64url")
  );
  if (suppliedSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) return null;
  return Buffer.from(encoded, "base64url").toString();
}

function proxiedStreamUrl(channelId, target) {
  const query = new URLSearchParams({ url: target });
  if (onVercel) {
    const secret = process.env.RELAY_SECRET || process.env.ADMIN_PASSWORD;
    if (!secret) throw new Error("Set RELAY_SECRET in Vercel to enable the stream relay.");
    const expiresAt = Date.now() + 60 * 60 * 1000;
    query.set("expires", String(expiresAt));
    query.set("signature", signValue(`${channelId}\n${expiresAt}\n${target}`, secret));
  }
  return `/api/stream/${encodeURIComponent(channelId)}?${query}`;
}

async function fetchPublicStream(initialUrl, headers, channelTargets, signal) {
  let target = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const url = await assertPublicUrl(target);
    const response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: url.href };
    }
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: url.href };
    target = new URL(location, url).href;
    rememberStreamTarget(channelTargets, target);
    await response.body?.cancel();
  }
  throw new Error("Stream source redirected too many times");
}

app.get("/api/stream/:channelId", async (req, res) => {
  const { channelId } = req.params;
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  try {
    const channels = await getChannels();
    const channel = channels.find((item) => item.id === channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found." });

    const relaySecret = process.env.RELAY_SECRET || process.env.ADMIN_PASSWORD;
    if (onVercel && !relaySecret) {
      return res.status(503).json({ error: "Set RELAY_SECRET in Vercel to enable the stream relay." });
    }
    const targets = getStreamTargets(channelId);
    const streamQuery = new URL(req.originalUrl, "http://localhost").searchParams;
    const target = streamQuery.get("url") || channel.url;
    if (typeof target !== "string") return res.status(400).json({ error: "Invalid stream URL." });
    if (onVercel && target !== channel.url) {
      const expiresAt = Number(streamQuery.get("expires"));
      const signature = streamQuery.get("signature");
      const signedValue = verifySignedValue(signature, relaySecret);
      const expectedValue = `${channelId}\n${expiresAt}\n${target}`;
      if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now() || signedValue !== expectedValue) {
        return res.status(403).json({ error: "Stream URL signature is invalid or expired." });
      }
    } else if (target === channel.url) {
      rememberStreamTarget(targets, target);
    } else if (!targets.has(target)) {
      return res.status(403).json({ error: "Stream URL is not part of this channel." });
    }
    await assertPublicUrl(target);

    const { response, finalUrl } = await fetchPublicStream(target, {
      "User-Agent": "JUGAADTV/1.0 (local IPTV player)",
      ...(req.headers.range ? { Range: req.headers.range } : {})
    }, targets, controller.signal);

    res.status(response.status);
    for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");

    const contentType = response.headers.get("content-type") || "";
    const isManifest = /\.m3u8(?:$|[?#])/i.test(finalUrl) ||
      /(?:mpegurl|m3u8)/i.test(contentType);
    if (isManifest && response.ok) {
      const body = await response.text();
      if (!body.trimStart().startsWith("#EXTM3U")) {
        res.status(502).json({ error: "Stream source returned an invalid HLS manifest." });
        return;
      }
      const rewriteUri = (uri) => {
        const absoluteUrl = new URL(uri, finalUrl).href;
        rememberStreamTarget(targets, absoluteUrl);
        return proxiedStreamUrl(channelId, absoluteUrl);
      };
      const rewritten = body.split(/\r?\n/).map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/gi, (_match, uri) => `URI="${rewriteUri(uri)}"`);
        }
        return rewriteUri(trimmed);
      }).join("\n");
      res.removeHeader("Content-Length");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewritten);
      return;
    }
    if (!response.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || res.destroyed || error.name === "AbortError") return;
    console.error(`Stream relay failed for channel ${channelId}:`, error);
    if (!res.headersSent) res.status(502).json({ error: "Could not load this stream.", details: error.message });
    else res.destroy(error);
  }
});

function readCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";").map((cookie) => cookie.trim());
  const cookie = cookies.find((entry) => entry.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

function requireAdmin(req, res, next) {
  const token = readCookie(req, "tvvibe_session");
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const session = configuredPassword ? verifySignedValue(token, configuredPassword) : null;
  const expiresAt = Number(session?.split(".")[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) {
    return res.status(401).json({ error: "Please sign in as admin." });
  }
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "JUGAADTV",
    adminConfigured: Boolean(process.env.ADMIN_PASSWORD),
    relayConfigured: !onVercel || Boolean(process.env.RELAY_SECRET || process.env.ADMIN_PASSWORD)
  });
});

app.get("/api/channels", async (_req, res) => {
  try {
    const channels = await getChannels();
    res.setHeader("Cache-Control", "no-store");
    res.json({ channels, total: channels.length });
  } catch (error) {
    console.error("Playlist fetch failed:", error);
    res.status(502).json({ error: "Could not load the public IPTV playlist.", details: error.message });
  }
});

app.post("/api/admin/login", (req, res) => {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword) {
    return res.status(503).json({ error: "Admin login is disabled. Set ADMIN_PASSWORD before starting the server." });
  }

  const address = req.ip || "local";
  const attempt = loginAttempts.get(address);
  if (attempt && attempt.blockedUntil > Date.now()) {
    return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  }

  const submitted = typeof req.body?.password === "string" ? req.body.password : "";
  const expectedBytes = Buffer.from(configuredPassword);
  const submittedBytes = Buffer.from(submitted);
  const valid = expectedBytes.length === submittedBytes.length &&
    crypto.timingSafeEqual(expectedBytes, submittedBytes);
  if (!valid) {
    const failures = (attempt?.failures || 0) + 1;
    loginAttempts.set(address, {
      failures,
      blockedUntil: failures >= 5 ? Date.now() + 5 * 60 * 1000 : 0
    });
    return res.status(401).json({ error: "Incorrect admin password." });
  }

  loginAttempts.delete(address);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const token = signValue(`${expiresAt}.${crypto.randomBytes(16).toString("base64url")}`, configuredPassword);
  res.cookie("tvvibe_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: production,
    maxAge: SESSION_TTL_MS,
    path: "/"
  });
  res.json({ ok: true });
});

app.get("/api/admin/session", (req, res) => {
  const token = readCookie(req, "tvvibe_session");
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const session = configuredPassword ? verifySignedValue(token, configuredPassword) : null;
  const expiresAt = Number(session?.split(".")[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, expiresAt });
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("tvvibe_session", { httpOnly: true, sameSite: "strict", secure: production, path: "/" });
  res.status(204).end();
});

app.post("/api/admin/refresh", requireAdmin, async (_req, res) => {
  try {
    const channels = await getChannels(true);
    res.json({ ok: true, total: channels.length, refreshedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Admin playlist refresh failed:", error);
    res.status(502).json({ error: "Playlist refresh failed.", details: error.message });
  }
});

if (production && !onVercel) {
  const distPath = path.resolve(dirname, "../dist");
  app.use(express.static(distPath));
  app.get("*splat", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
}

if (onVercel) {
  console.warn("Admin login disabled; set ADMIN_PASSWORD in Vercel to enable it.");
} else {
  app.listen(PORT, HOST, () => {
    console.log(`JUGAADTV API listening on http://localhost:${PORT}`);
    if (!process.env.ADMIN_PASSWORD) {
      console.warn("Admin login disabled; start with ADMIN_PASSWORD='your-password' to enable it.");
    }
  });
}

export default app;
