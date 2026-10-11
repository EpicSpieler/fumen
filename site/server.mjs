// Fumen's site: the homepage and the server half of "Log in with osu!".
//
// osu!'s OAuth needs the app's client secret to turn a login into tokens, and a desktop app can't
// keep a secret. So it lives here, in the .env next to this file, and nowhere else:
//   1. Fumen opens osu!'s login with redirect_uri <origin>/oauth/callback and
//      state "<port>-<nonce>", the port being where Fumen listens on 127.0.0.1.
//   2. osu! sends the browser here, and this sends it on to http://127.0.0.1:<port>/callback with
//      the code. Nothing is stored here.
//   3. Fumen posts the code to /oauth/token; this trades it for osu!'s tokens with the secret.
//      /oauth/refresh does the same for refresh tokens.
//
// No dependencies (Node 20+): `node --env-file=.env server.mjs`, settings as in .env.example.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** where Fumen comes back to: "<port>-<nonce>" */
const STATE = /^(\d{4,5})-([A-Za-z0-9_-]{16,128})$/;
/** requests to /oauth/token and /oauth/refresh per address and minute */
const OAUTH_PER_MINUTE = 30;

export function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT ?? 3020),
    host: env.HOST ?? "127.0.0.1",
    origin: (env.PUBLIC_ORIGIN ?? "https://fumen.dertesti.dev").replace(/\/+$/, ""),
    clientId: env.OSU_CLIENT_ID ?? "",
    clientSecret: env.OSU_CLIENT_SECRET ?? "",
    tokenUrl: env.OSU_TOKEN_URL ?? "https://osu.ppy.sh/oauth/token",
    publicDir: fileURLToPath(new URL("./public/", import.meta.url)),
  };
}

export function createSite(config) {
  const redirectUri = `${config.origin}/oauth/callback`;
  const hits = new Map();

  const limited = (req) => {
    const who = req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?";
    const now = Date.now();
    const h = hits.get(who);
    if (!h || now - h.since > 60_000) {
      hits.set(who, { since: now, n: 1 });
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.since > 60_000) hits.delete(k);
      return false;
    }
    return ++h.n > OAUTH_PER_MINUTE;
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Cache-Control": "no-store", ...headers });
    res.end(body);
  };
  const json = (res, status, value) => send(res, status, JSON.stringify(value), { "Content-Type": "application/json" });

  const message = (res, status, title, text) =>
    send(
      res,
      status,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Fumen</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/site.css"></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`,
      { "Content-Type": TYPES[".html"], ...PAGE_HEADERS },
    );

  async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 8192) throw new Error("too large");
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  /** a token request to osu!, its answer passed on (tokens only) */
  async function osuToken(res, grant) {
    if (!config.clientId || !config.clientSecret) return json(res, 503, { error: "not_configured", message: "The osu! login isn't set up on this server yet." });
    let r;
    try {
      r = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...grant }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return json(res, 502, { error: "osu_unreachable", message: "osu! didn't answer. Try again in a moment." });
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || typeof data.access_token !== "string") {
      return json(res, r.ok ? 502 : r.status, { error: data.error ?? "osu_error", message: data.message ?? data.hint ?? "osu! didn't accept the login." });
    }
    const { token_type, expires_in, access_token, refresh_token } = data;
    json(res, 200, { token_type, expires_in, access_token, refresh_token });
  }

  async function staticFile(res, pathname, head) {
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const file = normalize(join(config.publicDir, rel));
    if (!file.startsWith(config.publicDir.endsWith(sep) ? config.publicDir : config.publicDir + sep)) return false;
    let data;
    try {
      data = await readFile(file);
    } catch {
      return false;
    }
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": type.startsWith("text/html") ? "no-cache" : "public, max-age=86400",
      ...(type.startsWith("text/html") ? PAGE_HEADERS : { "X-Content-Type-Options": "nosniff" }),
    });
    res.end(head ? undefined : data);
    return true;
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://site");
    const { pathname } = url;
    try {
      if (pathname === "/health") {
        return config.clientId && config.clientSecret ? send(res, 200, "ok") : send(res, 503, "osu! client secret missing");
      }

      if (pathname === "/oauth/callback" && req.method === "GET") {
        const m = STATE.exec(url.searchParams.get("state") ?? "");
        const port = m ? Number(m[1]) : 0;
        if (!m || port < 1024 || port > 65535) {
          return message(res, 400, "That didn't work", "This login didn't start in Fumen. Start it again from Fumen's settings.");
        }
        const back = new URL(`http://127.0.0.1:${port}/callback`);
        back.searchParams.set("state", m[0]);
        const code = url.searchParams.get("code");
        if (code) back.searchParams.set("code", code);
        else back.searchParams.set("error", url.searchParams.get("error") ?? "no_code");
        return send(res, 302, "", { Location: back.href, "Referrer-Policy": "no-referrer" });
      }

      if ((pathname === "/oauth/token" || pathname === "/oauth/refresh") && req.method === "POST") {
        if (limited(req)) return json(res, 429, { error: "slow_down", message: "Too many logins at once. Wait a minute." });
        let input;
        try {
          input = await body(req);
        } catch {
          return json(res, 400, { error: "bad_request", message: "That request wasn't readable." });
        }
        if (pathname === "/oauth/token") {
          if (typeof input.code !== "string" || !input.code || input.code.length > 4096) return json(res, 400, { error: "bad_request", message: "No login code." });
          return await osuToken(res, { grant_type: "authorization_code", code: input.code, redirect_uri: redirectUri });
        }
        if (typeof input.refresh_token !== "string" || !input.refresh_token || input.refresh_token.length > 8192) return json(res, 400, { error: "bad_request", message: "No refresh token." });
        return await osuToken(res, { grant_type: "refresh_token", refresh_token: input.refresh_token });
      }

      if ((req.method === "GET" || req.method === "HEAD") && (await staticFile(res, pathname, req.method === "HEAD"))) return;
      return message(res, 404, "Not here", `There's nothing at this address. <a href="/">Fumen</a>`);
    } catch (e) {
      console.error(`[site] ${req.method} ${pathname}:`, e instanceof Error ? e.message : e);
      if (!res.headersSent) send(res, 500, "Something went wrong.");
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = configFromEnv();
  if (!config.clientId || !config.clientSecret) console.warn("[site] OSU_CLIENT_ID / OSU_CLIENT_SECRET not set: the osu! login answers 503");
  createServer(createSite(config)).listen(config.port, config.host, () => console.log(`[site] ${config.origin} on ${config.host}:${config.port}`));
}
