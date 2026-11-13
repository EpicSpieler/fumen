//! Heart rate straps over Bluetooth LE: the standard Heart Rate Service that Moofit's straps, most
//! chest straps and watches sharing their pulse speak. Fumen finds them, connects to the one picked
//! (again after a drop, for as long as it's wanted) and hands every reading on: the window keeps it
//! with each try at a map, the OBS pages show it (`heart` part). Nothing goes anywhere else.
//!
//! A strap talks to one app at a time (some to two): with a phone app connected, Fumen may not
//! find it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{Central, CharPropFlags, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use serde::Serialize;
use uuid::Uuid;

use crate::error::{Error, Result};

const HEART_RATE_SERVICE: Uuid = uuid_from_u16(0x180D);
const HEART_RATE_MEASUREMENT: Uuid = uuid_from_u16(0x2A37);
const BATTERY_LEVEL: Uuid = uuid_from_u16(0x2A19);
/// how long a search listens
const SCAN_FOR: Duration = Duration::from_secs(5);
/// how long connecting looks for the strap before trying again
const FIND_FOR: Duration = Duration::from_secs(15);
/// no reading for this long: the strap is gone (straps send about once a second)
const QUIET: Duration = Duration::from_secs(8);
/// between tries to get a lost strap back
const RETRY: Duration = Duration::from_secs(4);

/// A strap found by a search.
#[derive(Debug, Clone, Serialize)]
pub struct Device {
    /// btleplug's id for it (the Bluetooth address on Windows and Linux)
    pub id: String,
    pub name: String,
    /// signal strength, dBm
    pub rssi: Option<i16>,
}

/// One reading: beats per minute, and whether the strap touches skin (when it says).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Reading {
    pub bpm: u16,
    pub contact: Option<bool>,
}

/// How the connection goes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "off", "connecting", "on" or "lost"
    pub state: &'static str,
    pub name: Option<String>,
    /// battery, percent (when the strap says)
    pub battery: Option<u8>,
    /// why it's not on, in words
    pub message: Option<String>,
}

/// The Heart Rate Measurement characteristic (Bluetooth's Heart Rate Service 1.0): flags, then the
/// rate as one byte or (flag bit 0) two, little endian. Bits 1–2: skin contact, when supported.
pub fn parse(data: &[u8]) -> Option<Reading> {
    let flags = *data.first()?;
    let bpm = if flags & 1 == 0 { u16::from(*data.get(1)?) } else { u16::from_le_bytes([*data.get(1)?, *data.get(2)?]) };
    let contact = (flags & 0b100 != 0).then_some(flags & 0b10 != 0);
    Some(Reading { bpm, contact })
}

async fn adapter() -> Result<Adapter> {
    let fail = |e: btleplug::Error| Error::known("heart-bluetooth", format!("Bluetooth isn't available: {e}"));
    let manager = Manager::new().await.map_err(fail)?;
    manager
        .adapters()
        .await
        .map_err(fail)?
        .into_iter()
        .next()
        .ok_or_else(|| Error::known("heart-bluetooth", "This PC has no Bluetooth (or it's switched off)."))
}

async fn is_strap(p: &Peripheral) -> Option<Device> {
    let props = p.properties().await.ok()??;
    // the search asks for the service; a strap that doesn't name it in its advertising still has a name
    if !props.services.contains(&HEART_RATE_SERVICE) && props.local_name.is_none() {
        return None;
    }
    Some(Device { id: p.id().to_string(), name: props.local_name.unwrap_or_else(|| "Heart rate monitor".into()), rssi: props.rssi })
}

/// Straps in reach (those advertising the Heart Rate Service), strongest first.
pub async fn scan() -> Result<Vec<Device>> {
    let adapter = adapter().await?;
    adapter
        .start_scan(ScanFilter { services: vec![HEART_RATE_SERVICE] })
        .await
        .map_err(|e| Error::known("heart-bluetooth", format!("Couldn't search: {e}")))?;
    tokio::time::sleep(SCAN_FOR).await;
    let found = adapter.peripherals().await.unwrap_or_default();
    let _ = adapter.stop_scan().await;
    let mut out = Vec::new();
    for p in found {
        if let Some(d) = is_strap(&p).await {
            out.push(d);
        }
    }
    out.sort_by_key(|d| std::cmp::Reverse(d.rssi.unwrap_or(i16::MIN)));
    Ok(out)
}

/// The connection wanted now: set to false, it ends.
static WANTED: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Ends the connection (if any).
pub fn disconnect() {
    if let Some(w) = WANTED.lock().unwrap_or_else(|e| e.into_inner()).take() {
        w.store(false, Ordering::SeqCst);
    }
}

/// Connects to the strap `id` (`name` for the words until it's there) and keeps it: `status` hears
/// how it goes, `reading` gets every reading. Replaces any connection before.
pub fn connect(id: String, name: String, status: impl Fn(Status) + Send + Sync + 'static, reading: impl Fn(Reading) + Send + Sync + 'static) {
    let wanted = Arc::new(AtomicBool::new(true));
    if let Some(old) = WANTED.lock().unwrap_or_else(|e| e.into_inner()).replace(wanted.clone()) {
        old.store(false, Ordering::SeqCst);
    }
    tauri::async_runtime::spawn(async move {
        let say = |state: &'static str, battery: Option<u8>, message: Option<String>| status(Status { state, name: Some(name.clone()), battery, message });
        while wanted.load(Ordering::SeqCst) {
            say("connecting", None, None);
            let why = match run(&id, &wanted, &|battery| say("on", battery, None), &reading).await {
                Ok(()) => None,
                Err(e) => Some(e.to_string()),
            };
            if !wanted.load(Ordering::SeqCst) {
                break;
            }
            say("lost", None, why);
            tokio::time::sleep(RETRY).await;
        }
        status(Status { state: "off", name: None, battery: None, message: None });
    });
}

/// One connection, until it drops or isn't wanted any more.
async fn run(id: &str, wanted: &AtomicBool, on: &(dyn Fn(Option<u8>) + Sync), reading: &(dyn Fn(Reading) + Send + Sync)) -> Result<()> {
    let adapter = adapter().await?;
    let gone = |e: btleplug::Error| Error::known("heart-lost", format!("The heart rate monitor dropped out: {e}"));
    // it has to be seen first (a search) before it can be connected to
    let _ = adapter.start_scan(ScanFilter { services: vec![HEART_RATE_SERVICE] }).await;
    let started = tokio::time::Instant::now();
    let strap = loop {
        if !wanted.load(Ordering::SeqCst) {
            let _ = adapter.stop_scan().await;
            return Ok(());
        }
        let found = adapter.peripherals().await.unwrap_or_default();
        if let Some(p) = found.into_iter().find(|p| p.id().to_string() == id) {
            break p;
        }
        if started.elapsed() > FIND_FOR {
            let _ = adapter.stop_scan().await;
            return Err(Error::known("heart-lost", "The heart rate monitor isn't in reach. Is it on, and not connected to another app?"));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    };
    let _ = adapter.stop_scan().await;
    if !strap.is_connected().await.unwrap_or(false) {
        strap.connect().await.map_err(gone)?;
    }
    strap.discover_services().await.map_err(gone)?;
    let chars = strap.characteristics();
    let measure = chars
        .iter()
        .find(|c| c.uuid == HEART_RATE_MEASUREMENT && c.properties.contains(CharPropFlags::NOTIFY))
        .cloned()
        .ok_or_else(|| Error::known("heart-lost", "That device doesn't share a heart rate."))?;
    let battery = match chars.iter().find(|c| c.uuid == BATTERY_LEVEL && c.properties.contains(CharPropFlags::READ)) {
        Some(c) => strap.read(c).await.ok().and_then(|v| v.first().copied()).filter(|b| *b <= 100),
        None => None,
    };
    strap.subscribe(&measure).await.map_err(gone)?;
    let mut notes = strap.notifications().await.map_err(gone)?;
    on(battery);
    let mut heard = tokio::time::Instant::now();
    let result = loop {
        if !wanted.load(Ordering::SeqCst) {
            break Ok(());
        }
        match tokio::time::timeout(Duration::from_millis(500), notes.next()).await {
            Ok(Some(n)) if n.uuid == HEART_RATE_MEASUREMENT => {
                heard = tokio::time::Instant::now();
                if let Some(r) = parse(&n.value) {
                    reading(r);
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => break Err(Error::known("heart-lost", "The heart rate monitor dropped out.")),
            Err(_) => {}
        }
        // nothing for a while: still connected? (a strap without skin contact may just be quiet)
        if heard.elapsed() > QUIET {
            if !strap.is_connected().await.unwrap_or(false) {
                break Err(Error::known("heart-lost", "The heart rate monitor dropped out."));
            }
            heard = tokio::time::Instant::now();
        }
    };
    let _ = strap.unsubscribe(&measure).await;
    let _ = strap.disconnect().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readings_as_the_service_sends_them() {
        // one byte, no contact info
        assert_eq!(parse(&[0x00, 72]), Some(Reading { bpm: 72, contact: None }));
        // two bytes
        assert_eq!(parse(&[0x01, 0x2C, 0x01]), Some(Reading { bpm: 300, contact: None }));
        // contact supported: detected, then not
        assert_eq!(parse(&[0x06, 95]), Some(Reading { bpm: 95, contact: Some(true) }));
        assert_eq!(parse(&[0x04, 0]), Some(Reading { bpm: 0, contact: Some(false) }));
        // with RR intervals after it
        assert_eq!(parse(&[0x16, 120, 0x00, 0x02]), Some(Reading { bpm: 120, contact: Some(true) }));
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&[0x01, 80]), None);
    }
}
