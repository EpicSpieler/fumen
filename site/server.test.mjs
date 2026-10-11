import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv, createSite } from "./server.mjs";

// osu!'s token endpoint, played by a local server
const seen = [];
const osu = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const form = Object.fromEntries(new URLSearchParams(raw));
  seen.push(form);
  const ok = form.client_secret === "s3cret" && (form.code === "good" || form.refresh_token === "r1");
  res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
  res.end(JSON.stringify(ok ? { token_type: "Bearer", expires_in: 86400, access_token: "a1", refresh_token: "r2", extra: "dropped" } : { error: "invalid_grant", message: "The provided authorization grant is invalid." }));
});

let base = "";
let site;
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

beforeAll(async () => {
  const osuPort = await listen(osu);
  const config = { ...configFromEnv({}), clientId: "71003", clientSecret: "s3cret", tokenUrl: `http://127.0.0.1:${osuPort}/oauth/token` };
  site = createServer(createSite(config));
  base = `http://127.0.0.1:${await listen(site)}`;
});
afterAll(() => {
  site.close();
  osu.close();
});

const post = (path, body) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });

describe("site", () => {
  it("serves the page", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await r.text()).toContain("Upcoming project");
  });

  it("keeps to its folder", async () => {
    expect((await fetch(base + "/..%2Fserver.mjs")).status).toBe(404);
    expect((await fetch(base + "/%2e%2e/.env.example")).status).toBe(404);
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
