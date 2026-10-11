//! "Log in with osu!" (osu! API v2, OAuth authorization code).
//!
//! osu! hands out tokens only for the app's client secret, which a desktop app can't keep, so the
//! secret lives on Fumen's site (`site/server.mjs`) and the login goes through it:
//!   1. Fumen listens on 127.0.0.1 (a free port) and opens osu!'s login in the browser, with the
//!      site's /oauth/callback as the way back and "<port>-<nonce>" as the state;
//!   2. the site sends the browser on to Fumen's listener with the code;
//!   3. Fumen trades the code for tokens at the site (/oauth/token; /oauth/refresh later on).
//! Tokens and the account stay in Fumen's data folder (`osu-account.json`).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// The osu! OAuth application "Fumen"
pub const CLIENT_ID: u32 = 71003;
const SCOPES: &str = "identify public";
const FILE: &str = "osu-account.json";
/// how long the browser has to come back
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// tokens are renewed when they have less left than this
const RENEW_BEFORE_MS: i64 = 5 * 60 * 1000;
/// the API's score format with solo score ids (the ids lazer keeps as a score's online id)
const API_VERSION: &str = "20240529";

/// Where the login and osu! live (tests point these at local servers).
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub site: String,
    pub osu: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints { site: "https://fumen.dertesti.dev".into(), osu: "https://osu.ppy.sh".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: u64,
    pub username: String,
    pub avatar: Option<String>,
    pub country: Option<String>,
    /// the player's main ruleset on osu! ("osu", "taiko", "fruits", "mania"); rank and pp are in it
    pub mode: Option<String>,
    pub rank: Option<u64>,
    pub country_rank: Option<u64>,
    pub pp: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Tokens {
    access: String,
    refresh: String,
    /// unix ms
    expires_at: i64,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    tokens: Tokens,
    account: Account,
}

// ── stored login ────────────────────────────────────────────────────────

fn read(data_dir: &Path) -> Option<Stored> {
    serde_json::from_slice(&std::fs::read(data_dir.join(FILE)).ok()?).ok()
}

fn write(data_dir: &Path, stored: &Stored) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(stored)?)?;
    std::fs::rename(&tmp, data_dir.join(FILE))?;
    Ok(())
}

/// The logged-in account as last seen (no network).
pub fn account(data_dir: &Path) -> Option<Account> {
    read(data_dir).map(|s| s.account)
}

// ── logging in ──────────────────────────────────────────────────────────

/// Logs in through the browser: `open` gets osu!'s login page to show. Waits until the browser
/// comes back, `cancel` is set or five minutes have passed.
pub fn login(data_dir: &Path, ep: &Endpoints, cancel: &AtomicBool, open: impl FnOnce(&str) -> Result<()>) -> Result<Account> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let state = format!("{}-{}", listener.local_addr()?.port(), nonce()?);
    open(&authorize_url(ep, &state))?;
    let (mut browser, code) = wait_for_code(&listener, &state, cancel)?;
    let result = token_request(ep, "token", &serde_json::json!({ "code": code })).and_then(|tokens| {
        let account = fetch_account(ep, &tokens.access)?;
        write(data_dir, &Stored { tokens, account: account.clone() })?;
        Ok(account)
    });
    // the browser tab says how it went
    let page = match &result {
        Ok(a) => page("Logged in", &format!("Hi {}! You can close this tab and go back to Fumen.", esc(&a.username))),
        Err(e) => page("That didn't work", &format!("{} Try again from Fumen.", esc(&e.to_string()))),
    };
    respond(&mut browser, 200, &page);
    result
}

/// osu!'s login page for this attempt.
fn authorize_url(ep: &Endpoints, state: &str) -> String {
    format!(
        "{}/oauth/authorize?client_id={CLIENT_ID}&redirect_uri={}&response_type=code&scope={}&state={}",
        ep.osu,
        enc(&format!("{}/oauth/callback", ep.site)),
        enc(SCOPES),
        enc(state)
    )
}

fn nonce() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| Error::known("internal", format!("No random numbers: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Accepts connections until the browser arrives with this attempt's state; returns the code and
/// the browser's connection (still to be answered).
fn wait_for_code(listener: &TcpListener, state: &str, cancel: &AtomicBool) -> Result<(TcpStream, String)> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(Error::known("login-cancelled", "The login was cancelled."));
        }
        if Instant::now() > deadline {
            return Err(Error::known("login-timeout", "The browser didn't come back from osu! in time."));
        }
        let mut stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let Some(target) = read_request_target(&mut stream) else { continue };
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        if path != "/callback" {
            respond(&mut stream, 404, &page("Not here", "Fumen is waiting for osu! on another address."));
            continue;
        }
        let param = |name: &str| query.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('=')).map(dec);
        if param("state").as_deref() != Some(state) {
            // a tab from an earlier attempt: this one keeps waiting
            respond(&mut stream, 400, &page("That didn't work", "This login is from an earlier try. Use the newest tab, or start again from Fumen."));
            continue;
        }
        if let Some(code) = param("code").filter(|c| !c.is_empty()) {
            return Ok((stream, code));
        }
        respond(&mut stream, 200, &page("Not logged in", "The login was cancelled. You can close this tab."));
        return Err(Error::known("login-cancelled", "The login was cancelled on osu!."));
    }
}

/// "/callback?…" from an HTTP request's first line.
fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    let mut first = head.lines().next()?.split(' ');
    match (first.next(), first.next()) {
        (Some("GET"), Some(target)) => Some(target.to_string()),
        _ => None,
    }
}

fn respond(stream: &mut TcpStream, status: u16, html: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        html.len()
    );
    let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(html.as_bytes()));
}

/// The browser tab's page, in Fumen's look.
fn page(title: &str, text: &str) -> String {
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title} · Fumen</title><style>html,body{{height:100%;margin:0}}body{{display:grid;place-items:center;background:#0d0d0d;color:#fff;font:15px/1.5 system-ui,sans-serif}}main{{padding:24px;text-align:center}}h1{{margin:0 0 6px;font-size:24px;letter-spacing:-.02em}}p{{margin:0;color:rgba(255,255,255,.5)}}</style></head><body><main><h1>{title}</h1><p>{text}</p></main></body></html>"#
    )
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// percent-encoding for a query value
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let hex = |j: usize| b.get(j).and_then(|&c| (c as char).to_digit(16));
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' => match (hex(i + 1), hex(i + 2)) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── tokens and the API ──────────────────────────────────────────────────

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(crate::downloads::USER_AGENT)
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// A request that didn't get through, in words: a name that can't be looked up is usually the
/// network's DNS (or no internet), not the server.
fn unreachable(code: &'static str, who: &str, url: &str, e: &ureq::Error) -> Error {
    let text = e.to_string();
    let host = url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or(url);
    let lookup = text.contains("11001") || text.contains("No such host") || text.contains("failed to lookup") || text.contains("Name or service not known");
    Error::known(
        code,
        if lookup {
            format!("Your network couldn't find {host}. Check the internet connection, or try again in a few minutes.")
        } else {
            format!("{who} didn't answer ({text}).")
        },
    )
}

/// The site's /oauth/token or /oauth/refresh.
fn token_request(ep: &Endpoints, kind: &str, body: &serde_json::Value) -> Result<Tokens> {
    let mut res = agent()
        .post(&format!("{}/oauth/{kind}", ep.site))
        .header("Content-Type", "application/json")
        .send(body.to_string())
        .map_err(|e| unreachable("login-failed", "Fumen's login server", &ep.site, &e))?;
    let status = res.status().as_u16();
    let data: serde_json::Value = res.body_mut().read_to_string().ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let text = |k: &str| data.get(k).and_then(|v| v.as_str()).map(str::to_string);
    if status != 200 {
        let message = text("message").unwrap_or_else(|| format!("Fumen's login server said {status}."));
        return Err(match (status, kind) {
            (400 | 401, "refresh") => Error::known("osu-logged-out", "Your osu! login has run out. Log in again."),
            (503, _) => Error::known("login-unavailable", message),
            _ => Error::known("login-failed", message),
        });
    }
    let (Some(access), Some(refresh)) = (text("access_token"), text("refresh_token")) else {
        return Err(Error::known("login-failed", "Fumen's login server sent no tokens."));
    };
    let expires_in = data.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
    Ok(Tokens { access, refresh, expires_at: crate::lazer::now_ms() + expires_in * 1000 })
}

#[derive(Deserialize)]
struct MeStats {
    global_rank: Option<u64>,
    country_rank: Option<u64>,
    pp: Option<f64>,
}

#[derive(Deserialize)]
struct Me {
    id: u64,
    username: String,
    avatar_url: Option<String>,
    country_code: Option<String>,
    playmode: Option<String>,
    statistics: Option<MeStats>,
}

/// GET on osu!'s API v2 (`path` after /api/v2/), as JSON.
pub fn api_get(ep: &Endpoints, access: &str, path: &str) -> Result<serde_json::Value> {
    let mut res = agent()
        .get(&format!("{}/api/v2/{path}", ep.osu))
        .header("Authorization", &format!("Bearer {access}"))
        .header("Accept", "application/json")
        .header("x-api-version", API_VERSION)
        .call()
        .map_err(|e| unreachable("osu-unreachable", "osu!", &ep.osu, &e))?;
    match res.status().as_u16() {
        200 => {}
        401 => return Err(Error::known("osu-logged-out", "Your osu! login has run out. Log in again.")),
        404 => return Err(Error::known("osu-not-found", "osu! doesn't have this.")),
        429 => return Err(Error::known("osu-busy", "osu! asked Fumen to slow down. Try again in a minute.")),
        s => return Err(Error::known("osu-unreachable", format!("osu! said {s}."))),
    }
    let text = res.body_mut().read_to_string().map_err(|e| Error::known("osu-unreachable", format!("osu! didn't answer fully ({e}).")))?;
    serde_json::from_str(&text).map_err(|e| Error::known("osu-unreachable", format!("osu!'s answer wasn't readable ({e}).")))
}

fn fetch_account(ep: &Endpoints, access: &str) -> Result<Account> {
    let me: Me = serde_json::from_value(api_get(ep, access, "me")?)
        .map_err(|e| Error::known("osu-unreachable", format!("osu!'s answer wasn't readable ({e}).")))?;
    let stats = me.statistics;
    Ok(Account {
        id: me.id,
        username: me.username,
        avatar: me.avatar_url,
        country: me.country_code,
        mode: me.playmode,
        rank: stats.as_ref().and_then(|s| s.global_rank),
        country_rank: stats.as_ref().and_then(|s| s.country_rank),
        pp: stats.as_ref().and_then(|s| s.pp),
    })
}

/// A usable access token, renewed through the site when it's about to run out. A login osu! no
/// longer accepts is forgotten.
pub fn access_token(data_dir: &Path, ep: &Endpoints) -> Result<String> {
    let mut stored = read(data_dir).ok_or_else(|| Error::known("osu-logged-out", "You're not logged in to osu!."))?;
    if stored.tokens.expires_at - crate::lazer::now_ms() > RENEW_BEFORE_MS {
        return Ok(stored.tokens.access);
    }
    match token_request(ep, "refresh", &serde_json::json!({ "refresh_token": stored.tokens.refresh })) {
        Ok(tokens) => {
            stored.tokens = tokens;
            write(data_dir, &stored)?;
            Ok(stored.tokens.access)
        }
        Err(e) => {
            if e.code() == "osu-logged-out" {
                let _ = std::fs::remove_file(data_dir.join(FILE));
            }
            Err(e)
        }
    }
}

/// Runs `f` with a usable access token. A login osu! turns down on the way is forgotten.
pub fn with_token<T>(data_dir: &Path, ep: &Endpoints, f: impl FnOnce(&str) -> Result<T>) -> Result<T> {
    let token = access_token(data_dir, ep)?;
    f(&token).inspect_err(|e| {
        if e.code() == "osu-logged-out" {
            let _ = std::fs::remove_file(data_dir.join(FILE));
        }
    })
}

/// The account as osu! has it now (rank, pp, …), saved for next time.
pub fn refresh_account(data_dir: &Path, ep: &Endpoints) -> Result<Account> {
    let account = with_token(data_dir, ep, |token| fetch_account(ep, token))?;
    if let Some(mut stored) = read(data_dir) {
        stored.account = account.clone();
        write(data_dir, &stored)?;
    }
    Ok(account)
}

/// Forgets the login; osu! is asked to revoke the token too (if it can't be reached, the token
/// just runs out).
pub fn logout(data_dir: &Path, ep: &Endpoints) -> Result<()> {
    if let Some(stored) = read(data_dir) {
        let _ = agent()
            .delete(&format!("{}/api/v2/oauth/tokens/current", ep.osu))
            .header("Authorization", &format!("Bearer {}", stored.tokens.access))
            .call();
    }
    match std::fs::remove_file(data_dir.join(FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::mock;
    use std::sync::{Arc, Mutex};

    fn servers() -> (Endpoints, Arc<Mutex<Vec<String>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let c = calls.clone();
        let site = mock(Box::new(move |method, path, _, body| {
            c.lock().unwrap().push(format!("{method} {path} {body}"));
            match (method, path) {
                ("POST", "/oauth/token") if body.contains(r#""code":"good""#) => {
                    (200, r#"{"token_type":"Bearer","expires_in":86400,"access_token":"a1","refresh_token":"r1"}"#.into())
                }
                ("POST", "/oauth/refresh") if body.contains(r#""refresh_token":"r1""#) => {
                    (200, r#"{"token_type":"Bearer","expires_in":86400,"access_token":"a2","refresh_token":"r2"}"#.into())
                }
                ("POST", "/oauth/refresh") => (400, r#"{"error":"invalid_grant","message":"The refresh token is invalid."}"#.into()),
                _ => (400, r#"{"error":"invalid_grant","message":"The provided authorization grant is invalid."}"#.into()),
            }
        }));
        let osu = mock(Box::new(|method, path, auth, _| match (method, path) {
            ("GET", "/api/v2/me") if auth == "Bearer a1" || auth == "Bearer a2" => (
                200,
                r#"{"id":2,"username":"peppy <3","avatar_url":"https://a.ppy.sh/2","country_code":"AU","playmode":"mania","statistics":{"global_rank":1234,"country_rank":56,"pp":7890.5}}"#.into(),
            ),
            ("GET", "/api/v2/me") => (401, "{}".into()),
            ("DELETE", "/api/v2/oauth/tokens/current") => (204, String::new()),
            _ => (404, "{}".into()),
        }));
        (Endpoints { site, osu }, calls)
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fumen-osu-auth-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// The browser coming back to Fumen with these queries, one after another.
    fn browser(url: &str, queries: impl Fn(&str) -> Vec<String> + Send + 'static) -> std::thread::JoinHandle<Vec<(u16, String)>> {
        let state = dec(url.split("state=").nth(1).unwrap());
        let port: u16 = state.split('-').next().unwrap().parse().unwrap();
        std::thread::spawn(move || {
            queries(&state)
                .iter()
                .map(|q| {
                    let mut r = agent().get(&format!("http://127.0.0.1:{port}{q}")).call().unwrap();
                    (r.status().as_u16(), r.body_mut().read_to_string().unwrap())
                })
                .collect()
        })
    }

    #[test]
    fn login_renew_logout() {
        let (ep, calls) = servers();
        let dir = temp("flow");
        let cancel = AtomicBool::new(false);
        let mut tab = None;
        let account = login(&dir, &ep, &cancel, |url| {
            let back = enc(&format!("{}/oauth/callback", ep.site));
            assert!(url.starts_with(&format!("{}/oauth/authorize?client_id=71003&redirect_uri={back}", ep.osu)), "{url}");
            assert!(url.contains("&scope=identify%20public&"), "{url}");
            tab = Some(browser(url, |state| {
                let port = state.split('-').next().unwrap().to_string();
                vec!["/favicon.ico".into(), format!("/callback?state={port}-earliertry&code=old"), format!("/callback?state={}&code=good", enc(state))]
            }));
            Ok(())
        })
        .unwrap();
        let pages = tab.unwrap().join().unwrap();
        assert_eq!(pages[0].0, 404);
        assert!(pages[1].0 == 400 && pages[1].1.contains("earlier try"), "{:?}", pages[1]);
        assert!(pages[2].0 == 200 && pages[2].1.contains("Hi peppy &lt;3!"), "{:?}", pages[2]);
        let want = Account {
            id: 2,
            username: "peppy <3".into(),
            avatar: Some("https://a.ppy.sh/2".into()),
            country: Some("AU".into()),
            mode: Some("mania".into()),
            rank: Some(1234),
            country_rank: Some(56),
            pp: Some(7890.5),
        };
        assert_eq!(account, want);
        assert_eq!(super::account(&dir), Some(want.clone()));
        assert!(calls.lock().unwrap().iter().any(|c| c == r#"POST /oauth/token {"code":"good"}"#));

        // still fresh: no renewal
        assert_eq!(access_token(&dir, &ep).unwrap(), "a1");
        // running out: renewed through the site
        let expire = |dir: &Path| {
            let mut s = read(dir).unwrap();
            s.tokens.expires_at = 0;
            write(dir, &s).unwrap();
        };
        expire(&dir);
        assert_eq!(access_token(&dir, &ep).unwrap(), "a2");
        assert_eq!(refresh_account(&dir, &ep).unwrap(), want);
        // a refresh token osu! doesn't take anymore: logged out
        expire(&dir);
        assert_eq!(access_token(&dir, &ep).unwrap_err().code(), "osu-logged-out");
        assert_eq!(super::account(&dir), None);

        // logging out forgets it
        let tokens = Tokens { access: "a1".into(), refresh: "r1".into(), expires_at: i64::MAX };
        write(&dir, &Stored { tokens, account: want }).unwrap();
        logout(&dir, &ep).unwrap();
        assert_eq!(super::account(&dir), None);
        logout(&dir, &ep).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declined_and_cancelled() {
        let (ep, _) = servers();
        let dir = temp("declined");
        let cancel = AtomicBool::new(false);
        let mut tab = None;
        let err = login(&dir, &ep, &cancel, |url| {
            tab = Some(browser(url, |state| vec![format!("/callback?state={}&error=access_denied", enc(state))]));
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.code(), "login-cancelled");
        assert!(tab.unwrap().join().unwrap()[0].1.contains("Not logged in"));

        // a code osu! didn't issue: the tab says so
        let mut tab = None;
        let err = login(&dir, &ep, &cancel, |url| {
            tab = Some(browser(url, |state| vec![format!("/callback?state={}&code=forged", enc(state))]));
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.code(), "login-failed");
        assert!(tab.unwrap().join().unwrap()[0].1.contains("authorization grant is invalid"));
        assert_eq!(super::account(&dir), None);

        // cancelled in Fumen while the browser is still out
        let cancel = Arc::new(AtomicBool::new(false));
        let c = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            c.store(true, Ordering::SeqCst);
        });
        assert_eq!(login(&dir, &ep, &cancel, |_| Ok(())).unwrap_err().code(), "login-cancelled");
    }

    #[test]
    fn unknown_host_in_words() {
        let ep = Endpoints { site: "https://no-such-host.invalid".into(), osu: "https://no-such-host.invalid".into() };
        let e = token_request(&ep, "token", &serde_json::json!({ "code": "x" })).unwrap_err();
        assert_eq!(e.to_string(), "Your network couldn't find no-such-host.invalid. Check the internet connection, or try again in a few minutes.");
    }

    #[test]
    fn encoding() {
        assert_eq!(enc("https://fumen.dertesti.dev/oauth/callback"), "https%3A%2F%2Ffumen.dertesti.dev%2Foauth%2Fcallback");
        assert_eq!(enc("identify public"), "identify%20public");
        assert_eq!(dec("a%20b+c%2Fd%zz%4"), "a b c/d%zz%4");
        assert_eq!(dec(&enc("Ünïcode & co")), "Ünïcode & co");
    }
}
