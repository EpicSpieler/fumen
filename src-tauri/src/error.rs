use serde::{Serialize, Serializer};

/// Errors crossing the IPC boundary serialise as `{ code, message }` so the UI can react to
/// known cases (e.g. `lazer-not-found`) and show the message for everything else.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{1}")]
    Known(&'static str, String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

impl Error {
    pub fn known(code: &'static str, message: impl Into<String>) -> Self {
        Error::Known(code, message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            Error::Known(code, _) => code,
            Error::Io(_) => "io",
            Error::Db(_) => "database",
            Error::Json(_) => "json",
            Error::Tauri(_) => "tauri",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Error", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
