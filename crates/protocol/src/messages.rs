use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub type PaneId = Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum PaneKind {
    Shell,
    Claude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum ShellSpec {
    Powershell,
    Cmd,
    Wsl { distro: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SpawnRequest {
    pub title: String,
    /// Empty means the user's profile directory.
    pub cwd: String,
    /// None/blank: interactive shell (or `claude` for claude panes).
    pub command: Option<String>,
    pub kind: PaneKind,
    pub shell: ShellSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "lowercase")]
#[ts(export)]
pub enum PaneStatus {
    Running,
    Exited { code: u32 },
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PaneInfo {
    pub id: PaneId,
    pub title: String,
    pub cwd: String,
    pub command: Option<String>,
    pub kind: PaneKind,
    pub shell: ShellSpec,
    pub status: PaneStatus,
    pub cols: u16,
    pub rows: u16,
}

/// UI → hostd control messages (JSON text frames).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
#[ts(export)]
pub enum ClientMsg {
    Hello { token: String, protocol_version: u32 },
    Spawn { request: SpawnRequest },
    Attach { pane: PaneId, cols: u16, rows: u16 },
    Detach { pane: PaneId },
    Resize { pane: PaneId, cols: u16, rows: u16 },
    Kill { pane: PaneId },
    Remove { pane: PaneId },
}

/// hostd → UI control messages (JSON text frames).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
#[ts(export)]
pub enum ServerMsg {
    Welcome { protocol_version: u32, panes: Vec<PaneInfo> },
    VersionMismatch { server_version: u32 },
    PaneAdded { pane: PaneInfo },
    PaneUpdated { pane: PaneInfo },
    PaneRemoved { pane: PaneId },
    Error { message: String },
}
