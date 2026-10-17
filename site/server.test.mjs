import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanCollections, configFromEnv, createSite, visitor } from "./server.mjs";

// osu!'s token endpoint and /me, played by a local server
const seen = [];
let meCalls = 0;
const osu = createServer(async (req, res) => {
  if (req.url === "/api/v2/me") {
    meCalls++;
    const ok = req.headers.authorization === `Bearer ${PLAYER_TOKEN}`;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(ok ? { id: 5 } : { authentication: "basic" }));
  }
  let raw = "";
  for await (const c of req) raw += c;
  const form = Object.fromEntries(new URLSearchParams(raw));
  seen.push(form);
  const ok = form.client_secret === "s3cret" && (form.code === "good" || form.refresh_token === "r1");
  res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
  res.end(JSON.stringify(ok ? { token_type: "Bearer", expires_in: 86400, access_token: "a1", refresh_token: "r2", extra: "dropped" } : { error: "invalid_grant", message: "The provided authorization grant is invalid." }));
});

const PLAYER_TOKEN = "player-token-0123456789abcdef";
let base = "";
let site;
// the updates folder, with a release in it and a file beside it that mustn't come out
const scratch = mkdtempSync(join(tmpdir(), "fumen-site-"));
const updates = join(scratch, "updates");
mkdirSync(updates);
const LATEST = { version: "0.4.0", platforms: { "windows-x86_64": { url: "https://fumen.dertesti.dev/updates/Fumen_0.4.0_x64-setup.exe" } } };
writeFileSync(join(updates, "latest.json"), JSON.stringify(LATEST));
writeFileSync(join(updates, "Fumen_0.4.0_x64-setup.exe"), "MZ installer");
writeFileSync(join(updates, "Fumen_0.4.0_abc1234_aarch64.dmg"), "disk image");
writeFileSync(join(scratch, "secret.json"), "{}");
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

beforeAll(async () => {
  const osuPort = await listen(osu);
  const config = { ...configFromEnv({}), clientId: "71003", clientSecret: "s3cret", tokenUrl: `http://127.0.0.1:${osuPort}/oauth/token`, updatesDir: updates, statsDir: join(scratch, "stats"), statsDelay: 10, cloudDir: join(scratch, "cloud"), osuApi: `http://127.0.0.1:${osuPort}/api/v2` };
  site = createServer(createSite(config));
  base = `http://127.0.0.1:${await listen(site)}`;
});
afterAll(() => {
  site.close();
  osu.close();
  rmSync(scratch, { recursive: true, force: true });
});

const post = (path, body) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
const cloud = (method, token, body) => fetch(base + "/api/collections", { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });

describe("visitors", () => {
  const req = (ip) => ({ headers: { "cf-connecting-ip": ip }, socket: {} });
  it("counts an IPv6 /64 as one visitor", () => {
    expect(visitor(req("2001:db8:1:2:aaaa::1"))).toBe("2001:db8:1:2::/64");
    expect(visitor(req("2001:DB8:1:2:ffff:1:2:3"))).toBe("2001:db8:1:2::/64");
    expect(visitor(req("2001:db8::5"))).toBe("2001:db8:0:0::/64");
    expect(visitor(req("203.0.113.9"))).toBe("203.0.113.9");
    expect(visitor(req("::ffff:203.0.113.9"))).toBe("203.0.113.9");
  });
});

describe("cloud collections", () => {
  const md5 = "0123456789ABCDEF0123456789abcdef";
  it("keeps what the app would keep", () => {
    expect(cleanCollections("nope")).toBeNull();
    expect(
      cleanCollections([
        { kind: "fumen", name: " Mine\u0007", maps: [{ md5, b: 75, s: 1 }, { md5: "x" }, { md5, b: -1, s: "1" }, null] },
        { kind: "smart", name: "Smart" },
        { kind: "smart", name: "Smart", query: "keys=7" },
        { kind: "evil", name: "x", maps: [] },
        { kind: "lazer", name: "   ", maps: [] },
        { kind: "stable", name: "y".repeat(500), maps: "no" },
        "junk",
      ]),
    ).toEqual([
      { kind: "fumen", name: "Mine", maps: [{ md5: md5.toLowerCase(), b: 75, s: 1 }, { md5: md5.toLowerCase() }] },
      { kind: "smart", name: "Smart", query: "keys=7", maps: [] },
      { kind: "stable", name: "y".repeat(100), maps: [] },
    ]);
    expect(cleanCollections(Array.from({ length: 3000 }, (_, i) => ({ kind: "fumen", name: `c${i}`, maps: [] })))).toHaveLength(2000);
  });
});

describe("site", () => {
  it("counts downloads and the people whose Fumen starts, once each", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect((await post("/api/ping", { id, version: "1.0.1" })).status).toBe(204);
    expect((await post("/api/ping", { id, version: "1.0.1" })).status).toBe(204);
    expect((await post("/api/ping", { id: "a".repeat(32), version: "1.0.0" })).status).toBe(204);
    expect((await post("/api/ping", { id: "not an id", version: "1.0.1" })).status).toBe(400);
    expect((await post("/api/ping", { id, version: "<script>" })).status).toBe(400);
    expect((await fetch(base + "/download/windows", { redirect: "manual" })).status).toBe(302);
    expect((await fetch(base + "/download/windows", { method: "HEAD", redirect: "manual" })).status).toBe(302);
    // the same visitor again the same day: not another download
    expect((await fetch(base + "/download/windows", { redirect: "manual" })).status).toBe(302);
    expect(await (await fetch(base + "/api/stats")).json()).toEqual({ downloads: 1, users: 2, everyone: 2 });
    await new Promise((r) => setTimeout(r, 100));
    const saved = JSON.parse(readFileSync(join(scratch, "stats", "stats.json"), "utf8"));
    expect(saved.downloads).toEqual({ windows: 1 });
    expect(saved.installs[id][2]).toBe("1.0.1");
  });


  it("saves, hands back and deletes a player's collections", async () => {
    expect((await cloud("GET", PLAYER_TOKEN)).status).toBe(404);
    const put = await cloud("PUT", PLAYER_TOKEN, { collections: [{ kind: "fumen", name: "A", maps: [{ md5: "a".repeat(32) }] }, { kind: "evil", name: "B" }] });
    expect(put.status).toBe(200);
    expect((await put.json()).collections).toBe(1);
    const got = await (await cloud("GET", PLAYER_TOKEN)).json();
    expect(got).toMatchObject({ user: 5, collections: [{ kind: "fumen", name: "A", maps: [{ md5: "a".repeat(32) }] }] });
    expect((await cloud("PUT", PLAYER_TOKEN, { collections: "x" })).status).toBe(400);
    expect((await cloud("DELETE", PLAYER_TOKEN)).status).toBe(204);
    expect((await cloud("GET", PLAYER_TOKEN)).status).toBe(404);
  });

  it("asks osu! about a refused token once a minute, not every time", async () => {
    const before = meCalls;
    for (let i = 0; i < 3; i++) expect((await cloud("GET", "not-a-real-token-0123456789")).status).toBe(401);
    expect(meCalls - before).toBe(1);
  });

  it("answers broken addresses without falling over", async () => {
    expect((await fetch(base + "/%E0%A4%A")).status).toBe(404);
    expect((await fetch(base + "/a%00b")).status).toBe(404);
  });

  it("sends its security headers", async () => {
    const page = await fetch(base + "/");
    expect(page.headers.get("strict-transport-security")).toContain("max-age=");
    expect(page.headers.get("permissions-policy")).toContain("camera=()");
    const stats = await fetch(base + "/api/stats");
    expect(stats.headers.get("x-content-type-options")).toBe("nosniff");
    expect(stats.headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("forgets people not seen for 90 days", async () => {
    const dir = join(scratch, "old-stats");
    mkdirSync(dir);
    const now = Date.now();
    const day = 24 * 3600_000;
    writeFileSync(join(dir, "stats.json"), JSON.stringify({ version: 1, downloads: { windows: 3 }, installs: { ["b".repeat(32)]: [now - 200 * day, now - 100 * day, "0.9.0"], ["c".repeat(32)]: [now - 50 * day, now - 40 * day, "1.0.0"] } }));
    const other = createServer(createSite({ ...configFromEnv({}), statsDir: dir }));
    const url = `http://127.0.0.1:${await listen(other)}`;
    expect(await (await fetch(url + "/api/stats")).json()).toEqual({ downloads: 3, users: 0, everyone: 1 });
    other.close();
  });

  it("serves the page", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await r.text()).toContain("A beatmap library for");
  });

  it("serves pages without their extension, scripts as scripts", async () => {
    const r = await fetch(base + "/roadmap");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("Roadmap");
    expect((await fetch(base + "/roadmap/")).status).toBe(200);
    expect((await fetch(base + "/roadmap.js")).headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(base + "/nothing-here")).status).toBe(404);
  });

  it("keeps to its folder", async () => {
    expect((await fetch(base + "/..%2Fserver.mjs")).status).toBe(404);
    expect((await fetch(base + "/%2e%2e/.env.example")).status).toBe(404);
  });

  it("hands out updates", async () => {
    const latest = await fetch(base + "/updates/latest.json");
    expect(latest.status).toBe(200);
    expect(latest.headers.get("cache-control")).toBe("no-store");
    expect(await latest.json()).toEqual(LATEST);
    const exe = await fetch(base + "/updates/Fumen_0.4.0_x64-setup.exe");
    expect(exe.status).toBe(200);
    expect(exe.headers.get("content-length")).toBe("12");
    expect(exe.headers.get("cache-control")).toContain("immutable");
    expect(await exe.text()).toBe("MZ installer");
    const dmg = await fetch(base + "/updates/Fumen_0.4.0_abc1234_aarch64.dmg");
    expect(dmg.status).toBe(200);
    expect(await dmg.text()).toBe("disk image");
    const head = await fetch(base + "/updates/latest.json", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("points the download buttons at the newest files", async () => {
    const info = await (await fetch(base + "/download/info")).json();
    expect(info.version).toBe("0.4.0");
    expect(info.windows).toMatchObject({ file: "Fumen_0.4.0_x64-setup.exe", size: 12, version: "0.4.0" });
    expect(info.macArm).toMatchObject({ file: "Fumen_0.4.0_abc1234_aarch64.dmg", version: "0.4.0" });
    expect(info.macIntel).toBeNull();
    const win = await fetch(base + "/download/windows", { redirect: "manual" });
    expect(win.status).toBe(302);
    expect(win.headers.get("location")).toBe("/updates/Fumen_0.4.0_x64-setup.exe");
    expect((await fetch(base + "/download/mac-arm", { redirect: "manual" })).headers.get("location")).toBe("/updates/Fumen_0.4.0_abc1234_aarch64.dmg");
    expect((await fetch(base + "/download/mac-intel", { redirect: "manual" })).status).toBe(404);
    expect((await fetch(base + "/download/linux", { redirect: "manual" })).status).toBe(404);
  });

  it("keeps updates to their folder", async () => {
    for (const path of ["/updates/missing.json", "/updates/..%2Fsecret.json", "/updates/%2e%2e/secret.json", "/updates/", "/updates/.hidden.json", "/updates/notes.txt"]) {
      expect((await fetch(base + path)).status, path).toBe(404);
    }
  });

  it("sends the browser back to Fumen", async () => {
    const state = "51234-abcdefghijklmnop0123";
    const r = await fetch(`${base}/oauth/callback?code=xyz&state=${state}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`http://127.0.0.1:51234/callback?state=${state}&code=xyz`);
    const denied = await fetch(`${base}/oauth/callback?error=access_denied&state=${state}`, { redirect: "manual" });
    expect(denied.headers.get("location")).toBe(`http://127.0.0.1:51234/callback?state=${state}&error=access_denied`);
  });

  it("only sends it to a port on this computer", async () => {
    for (const state of ["80-abcdefghijklmnop0123", "51234", "51234-short", "evil.com-abcdefghijklmnop0123", "99999-abcdefghijklmnop0123"]) {
      const r = await fetch(`${base}/oauth/callback?code=xyz&state=${encodeURIComponent(state)}`, { redirect: "manual" });
      expect(r.status, state).toBe(400);
    }
  });

  it("trades a code for tokens with the secret", async () => {
    const r = await post("/oauth/token", { code: "good" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ token_type: "Bearer", expires_in: 86400, access_token: "a1", refresh_token: "r2" });
    expect(seen.at(-1)).toEqual({
      client_id: "71003",
      client_secret: "s3cret",
      grant_type: "authorization_code",
      code: "good",
      redirect_uri: "https://fumen.dertesti.dev/oauth/callback",
    });
  });

  it("refreshes", async () => {
    const r = await post("/oauth/refresh", { refresh_token: "r1" });
    expect(r.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1" });
  });

  it("passes osu!'s refusal on", async () => {
    const r = await post("/oauth/token", { code: "bad" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_grant", message: "The provided authorization grant is invalid." });
    expect((await post("/oauth/token", {})).status).toBe(400);
    expect((await fetch(base + "/oauth/token", { method: "POST", body: "{not json" })).status).toBe(400);
  });

  it("says when it isn't set up", async () => {
    const bare = createServer(createSite({ ...configFromEnv({}), clientId: "", clientSecret: "" }));
    const url = `http://127.0.0.1:${await listen(bare)}`;
    expect((await fetch(url + "/health")).status).toBe(503);
    expect((await fetch(url + "/oauth/token", { method: "POST", body: '{"code":"good"}' })).status).toBe(503);
    bare.close();
    expect(await (await fetch(base + "/health")).text()).toBe("ok");
  });
});
