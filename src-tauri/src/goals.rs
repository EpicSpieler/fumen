//! The player's goals. Fumen keeps them as the UI hands them over (JSON with an `id`, a `created`
//! time and whatever the kind of goal needs); what they mean and how far along they are is worked
//! out in the UI, from the play history (src/lib/goals.ts). A rescan or logout never touches them.
use rusqlite::{params, Connection};
use serde_json::Value;

use crate::error::{Error, Result};

/// a goal is a handful of fields; anything bigger isn't one
const MAX_BYTES: usize = 16 * 1024;

/// All goals, oldest first.
pub fn list(conn: &Connection) -> Result<Vec<Value>> {
    let mut st = conn.prepare("SELECT data FROM goals ORDER BY created, id")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for data in rows {
        // a row that doesn't parse any more is skipped rather than failing the lot
        if let Ok(v) = serde_json::from_str(&data?) {
            out.push(v);
        }
    }
    Ok(out)
}

/// Adds a goal or replaces the one with its id.
pub fn put(conn: &Connection, goal: &Value) -> Result<()> {
    let id = goal.get("id").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 64);
    let created = goal.get("created").and_then(Value::as_i64);
    let (Some(id), Some(created)) = (id, created) else {
        return Err(Error::known("bad-goal", "A goal needs an id and the time it was set."));
    };
    let data = serde_json::to_string(goal)?;
    if data.len() > MAX_BYTES {
        return Err(Error::known("bad-goal", "That goal is too big."));
    }
    conn.execute(
        "INSERT INTO goals (id, created, data) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        params![id, created, data],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM goals WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE goals (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL);").unwrap();
        c
    }

    #[test]
    fn keeps_replaces_and_deletes() {
        let c = conn();
        put(&c, &json!({ "id": "b", "created": 2, "kind": "skill", "target": 4.0 })).unwrap();
        put(&c, &json!({ "id": "a", "created": 1, "kind": "chart", "acc": 0.96 })).unwrap();
        assert_eq!(list(&c).unwrap().iter().map(|g| g["id"].as_str().unwrap()).collect::<Vec<_>>(), ["a", "b"]);
        // the same id again: replaced (reached, say), still in its place
        put(&c, &json!({ "id": "a", "created": 1, "kind": "chart", "acc": 0.96, "done": 5 })).unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["done"], 5);
        delete(&c, "a").unwrap();
        assert_eq!(list(&c).unwrap().len(), 1);
    }

    #[test]
    fn refuses_what_isnt_a_goal() {
        let c = conn();
        assert!(put(&c, &json!({ "created": 1 })).is_err());
        assert!(put(&c, &json!({ "id": "", "created": 1 })).is_err());
        assert!(put(&c, &json!({ "id": "x" })).is_err());
        assert!(put(&c, &json!({ "id": "x", "created": 1, "pad": "y".repeat(MAX_BYTES) })).is_err());
        assert!(list(&c).unwrap().is_empty());
    }
}
