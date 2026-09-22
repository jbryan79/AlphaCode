# Panehost Plan 1 — Core: Persistent Terminal Grid

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri desktop app that shows any number of terminal panes in an auto-tiling grid, where every shell lives in a background daemon (`panehost-hostd`) and survives the window closing, reloading, or crashing.

**Architecture:** A Rust daemon owns ConPTY sessions, keeps a 4 MB output ring buffer per pane, and serves a token-authenticated WebSocket on `127.0.0.1`. The React UI (xterm.js) talks to the daemon directly; the Tauri shell only discovers/launches the daemon and hands the UI its endpoint. A shared `protocol` crate is the single wire contract and generates TypeScript types via ts-rs.

**Tech Stack:** Rust 1.96 (edition 2024), tokio, axum 0.8 (ws), portable-pty 0.9, ts-rs 12, Tauri 2 (NOT 3.x alpha), React 19, TypeScript, Vite, Vitest, xterm.js 6 (+fit, +webgl), pnpm 11.

**Spec:** `docs/superpowers/specs/2026-09-22-panehost-design.md`

**Plan series:** This is Plan 1 of 3.
- Plan 1 (this) — protocol, hostd core, UI grid, Tauri shell, discovery.
- Plan 2 — Claude integration: hook exe, `POST /hook`, claude state machine, hooks installer, transcript tokens/cost, tray + toasts + DND, waiting emphasis, close-to-tray, global hotkey, autostart.
- Plan 3 — Productivity: workspaces + resume-after-restart, command palette, broadcast + snippets, context drawer (git/ports/system), overflow strip, drag-reorder, light theme + settings, Playwright suite, version-skew restart flow.

## Global Constraints

- Platform: Windows 11 only. Shells: `powershell.exe` (Windows PowerShell 5.1, default), `cmd.exe`, `wsl.exe`. Do not assume `pwsh`.
- Tauri **2.x** (`tauri = "2"`, `@tauri-apps/cli@^2`). crates.io currently lists 3.0 alphas — never use them.
- hostd binds `127.0.0.1` only, OS-assigned port. Every WebSocket must send `Hello{token, protocol_version}` first; anything else closes the socket.
- `PROTOCOL_VERSION = 1`, defined in `crates/protocol/src/lib.rs` and mirrored in `ui/src/protocol/version.ts` (a test enforces they match).
- Data dir: `%APPDATA%\Panehost\` (`dirs::data_dir()/Panehost`), overridable via env `PANEHOST_DATA_DIR` (tests use this).
- Discovery file: `<data dir>\hostd.json` = `{port, token, pid, protocol_version}`, written atomically (temp + rename).
- Ring buffer: 4 MB per pane (`4 << 20`). Output batches: ≤16 KB or 8 ms. Per-pane output broadcast capacity: 64 batches (~1 MB lag budget) → overflow triggers reset + replay.
- Wire format: control = JSON text frames, tagged `{"type": ...}`, snake_case fields. Terminal data = binary frames `[16-byte pane UUID][payload]` both directions.
- Env injected into every PTY: `PANEHOST_PANE_ID`, `PANEHOST_PORT`, `PANEHOST_TOKEN`.
- Single-instance mutex: `Local\PanehostHostd-<hash of data dir>`.
- Fonts bundled (no network): Inter (UI), JetBrains Mono (terminals). Dark theme only in Plan 1; all colors as CSS custom properties on `:root`.
- Motion ≤150 ms; respect `prefers-reduced-motion`.
- Never use `alert()/confirm()/prompt()` in the UI.

## File Map

```
panehost/
├─ Cargo.toml                         workspace (members = crates/*)
├─ .cargo/config.toml                 TS_RS_EXPORT_DIR → ui/src/protocol/generated
├─ package.json / pnpm-workspace.yaml root scripts, @tauri-apps/cli
├─ scripts/make_icon.py               generates the source app icon
├─ crates/
│  ├─ protocol/src/
│  │  ├─ lib.rs          re-exports, PROTOCOL_VERSION
│  │  ├─ messages.rs     ClientMsg, ServerMsg, PaneInfo, PaneStatus, PaneKind, ShellSpec, SpawnRequest
│  │  ├─ frame.rs        encode_frame / decode_frame
│  │  └─ discovery.rs    DiscoveryInfo, data_dir(), write_atomic()
│  ├─ hostd/src/
│  │  ├─ lib.rs
│  │  ├─ ring.rs         RingBuffer
│  │  ├─ coalesce.rs     next_batch()
│  │  ├─ shell.rs        build_command(), resolve_cwd()
│  │  ├─ registry.rs     Registry, Pane (PTY lifecycle, pumps, events)
│  │  ├─ server.rs       ServerState, router(), serve()
│  │  ├─ connection.rs   per-WebSocket handshake, dispatch, attach streaming
│  │  ├─ instance.rs     named-mutex single instance
│  │  ├─ logging.rs      daily rolling file logs
│  │  └─ main.rs         binary entry
│  │  tests/ registry.rs, server.rs, binary.rs
│  └─ app/               Tauri 2 shell
│     ├─ build.rs, tauri.conf.json, capabilities/default.json, icons/
│     └─ src/ main.rs, hostd_launcher.rs
└─ ui/
   ├─ index.html, vite.config.ts, tsconfig.json, package.json
   └─ src/
      ├─ main.tsx, App.tsx, styles.css
      ├─ protocol/  generated/*.ts (ts-rs), version.ts, frames.ts, index.ts
      ├─ lib/       grid.ts, shortcuts.ts, panes.ts, client.ts, endpoint.ts, terminals.ts, useElementSize.ts
      └─ components/ StatusBar.tsx, Pane.tsx, TerminalView.tsx, NewPaneDialog.tsx
```

---

### Task 1: Workspace scaffold + protocol message types

**Files:**
- Create: `Cargo.toml`, `.gitignore`, `.cargo/config.toml`
- Create: `crates/protocol/Cargo.toml`, `crates/protocol/src/lib.rs`, `crates/protocol/src/messages.rs`
- Create: `ui/src/protocol/version.ts`
- Generated (committed): `ui/src/protocol/generated/*.ts`

**Interfaces:**
- Produces (Rust, crate `panehost_protocol`): `PROTOCOL_VERSION: u32`, `type PaneId = Uuid`, `enum PaneKind {Shell, Claude}`, `enum ShellSpec {Powershell, Cmd, Wsl{distro: Option<String>}}`, `struct SpawnRequest {title, cwd, command: Option<String>, kind, shell}`, `enum PaneStatus {Running, Exited{code: u32}, Error{message}}`, `struct PaneInfo {id, title, cwd, command, kind, shell, status, cols: u16, rows: u16}`, `enum ClientMsg`, `enum ServerMsg` (variants below).
- Produces (TS): same names in `ui/src/protocol/generated/`.

- [ ] **Step 1: Create the workspace files**

`Cargo.toml`:
```toml
[workspace]
resolver = "3"
members = ["crates/*"]

[workspace.package]
version = "0.1.0"
edition = "2024"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4", "serde"] }
ts-rs = { version = "12", features = ["uuid-impl"] }
dirs = "7"
tokio = { version = "1", features = ["full"] }
anyhow = "1"
tracing = "0.1"
tempfile = "3"
```

`.gitignore`:
```
/target
node_modules/
/ui/dist
/crates/app/gen
*.tmp
```

`.cargo/config.toml`:
```toml
[env]
TS_RS_EXPORT_DIR = { value = "ui/src/protocol/generated", relative = true }
```

`crates/protocol/Cargo.toml`:
```toml
[package]
name = "panehost-protocol"
version.workspace = true
edition.workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
uuid.workspace = true
ts-rs.workspace = true
dirs.workspace = true

[dev-dependencies]
tempfile.workspace = true
```

`ui/src/protocol/version.ts`:
```ts
// Must equal PROTOCOL_VERSION in crates/protocol/src/lib.rs (enforced by a Rust test).
export const PROTOCOL_VERSION = 1;
```

- [ ] **Step 2: Write the failing tests**

`crates/protocol/src/lib.rs`:
```rust
//! Wire contract shared by hostd, the Tauri app, and (via ts-rs) the UI.

mod messages;

pub use messages::*;

/// Bump on any incompatible change to messages or frames.
pub const PROTOCOL_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn id() -> Uuid {
        Uuid::parse_str("0194d2b0-7c1e-7a3b-9f00-123456789abc").unwrap()
    }

    #[test]
    fn client_msg_uses_type_tag_and_snake_case_fields() {
        let msg = ClientMsg::Attach { pane: id(), cols: 80, rows: 24 };
        assert_eq!(
            serde_json::to_value(&msg).unwrap(),
            json!({"type": "Attach", "pane": "0194d2b0-7c1e-7a3b-9f00-123456789abc", "cols": 80, "rows": 24})
        );
        let hello = ClientMsg::Hello { token: "t".into(), protocol_version: 1 };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            json!({"type": "Hello", "token": "t", "protocol_version": 1})
        );
    }

    #[test]
    fn status_and_shell_shapes() {
        assert_eq!(
            serde_json::to_value(PaneStatus::Exited { code: 3 }).unwrap(),
            json!({"state": "exited", "code": 3})
        );
        assert_eq!(serde_json::to_value(PaneStatus::Running).unwrap(), json!({"state": "running"}));
        assert_eq!(
            serde_json::to_value(ShellSpec::Wsl { distro: Some("Ubuntu".into()) }).unwrap(),
            json!({"kind": "wsl", "distro": "Ubuntu"})
        );
        assert_eq!(serde_json::to_value(ShellSpec::Powershell).unwrap(), json!({"kind": "powershell"}));
        assert_eq!(serde_json::to_value(PaneKind::Claude).unwrap(), json!("claude"));
    }

    #[test]
    fn server_msgs_round_trip() {
        let pane = PaneInfo {
            id: id(),
            title: "api".into(),
            cwd: "C:\\src".into(),
            command: Some("npm run dev".into()),
            kind: PaneKind::Shell,
            shell: ShellSpec::Powershell,
            status: PaneStatus::Error { message: "boom".into() },
            cols: 120,
            rows: 32,
        };
        let msgs = vec![
            ServerMsg::Welcome { protocol_version: 1, panes: vec![pane.clone()] },
            ServerMsg::VersionMismatch { server_version: 2 },
            ServerMsg::PaneAdded { pane: pane.clone() },
            ServerMsg::PaneUpdated { pane },
            ServerMsg::PaneRemoved { pane: id() },
            ServerMsg::Error { message: "nope".into() },
        ];
        for msg in msgs {
            let text = serde_json::to_string(&msg).unwrap();
            assert_eq!(serde_json::from_str::<ServerMsg>(&text).unwrap(), msg);
        }
    }

    #[test]
    fn spawn_request_accepts_missing_optional_fields() {
        let req: ClientMsg = serde_json::from_value(json!({
            "type": "Spawn",
            "request": {"title": "x", "cwd": "", "kind": "shell", "shell": {"kind": "wsl"}}
        }))
        .unwrap();
        let ClientMsg::Spawn { request } = req else { panic!("not a spawn") };
        assert_eq!(request.command, None);
        assert_eq!(request.shell, ShellSpec::Wsl { distro: None });
    }

    #[test]
    fn ui_protocol_version_matches() {
        let ts = include_str!("../../../ui/src/protocol/version.ts");
        assert!(
            ts.contains(&format!("PROTOCOL_VERSION = {PROTOCOL_VERSION};")),
            "ui/src/protocol/version.ts is out of sync with PROTOCOL_VERSION"
        );
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p panehost-protocol`
Expected: compile errors — `ClientMsg`, `PaneStatus`, etc. not found (`messages.rs` missing).

- [ ] **Step 4: Implement the message types**

`crates/protocol/src/messages.rs`:
```rust
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
```

- [ ] **Step 5: Run tests to verify they pass and TS types are generated**

Run: `cargo test -p panehost-protocol`
Expected: all tests PASS (including ts-rs's auto-generated `export_bindings_*` tests).
Run: `ls ui/src/protocol/generated`
Expected: `ClientMsg.ts PaneInfo.ts PaneKind.ts PaneStatus.ts ServerMsg.ts ShellSpec.ts SpawnRequest.ts`.
If the files landed in `crates/protocol/bindings/` instead, the `[env]` in `.cargo/config.toml` was not picked up — confirm the file path and that `relative = true` is present, delete `crates/protocol/bindings/`, and re-run. If cargo reports the `uuid-impl` feature does not exist, run `cargo info ts-rs` and use the listed uuid feature name.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock .gitignore .cargo crates/protocol ui/src/protocol
git commit -m "feat(protocol): wire message types with generated TS bindings"
```

---

### Task 2: Binary frames + discovery file

**Files:**
- Create: `crates/protocol/src/frame.rs`, `crates/protocol/src/discovery.rs`
- Modify: `crates/protocol/src/lib.rs` (add modules + re-exports)

**Interfaces:**
- Consumes: `PaneId`, `PROTOCOL_VERSION` (Task 1).
- Produces: `FRAME_HEADER_LEN: usize = 16`, `fn encode_frame(pane: &PaneId, data: &[u8]) -> Vec<u8>`, `fn decode_frame(frame: &[u8]) -> Option<(PaneId, &[u8])>`, `struct DiscoveryInfo {port: u16, token: String, pid: u32, protocol_version: u32}` with `fn read(dir: &Path) -> io::Result<Self>` and `fn write(&self, dir: &Path) -> io::Result<()>`, `const DATA_DIR_ENV: &str = "PANEHOST_DATA_DIR"`, `fn data_dir() -> PathBuf`, `fn discovery_path(dir: &Path) -> PathBuf`, `fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()>`.

- [ ] **Step 1: Write the failing tests**

`crates/protocol/src/frame.rs`:
```rust
use crate::PaneId;

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn id() -> Uuid {
        Uuid::parse_str("0194d2b0-7c1e-7a3b-9f00-123456789abc").unwrap()
    }

    // The same vector is asserted in ui/src/protocol/frames.test.ts.
    const VECTOR_HEX: &str = "0194d2b07c1e7a3b9f00123456789abc6869";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn encodes_uuid_bytes_then_payload() {
        assert_eq!(hex(&encode_frame(&id(), b"hi")), VECTOR_HEX);
    }

    #[test]
    fn decode_inverts_encode() {
        let frame = encode_frame(&id(), b"hello");
        assert_eq!(decode_frame(&frame), Some((id(), &b"hello"[..])));
        assert_eq!(decode_frame(&encode_frame(&id(), b"")), Some((id(), &b""[..])));
    }

    #[test]
    fn decode_rejects_short_frames() {
        assert_eq!(decode_frame(&[0u8; 15]), None);
    }
}
```

`crates/protocol/src/discovery.rs`:
```rust
use std::path::{Path, PathBuf};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let info = DiscoveryInfo { port: 4321, token: "abc".into(), pid: 42, protocol_version: 1 };
        info.write(dir.path()).unwrap();
        assert_eq!(DiscoveryInfo::read(dir.path()).unwrap(), info);
        assert!(!dir.path().join("hostd.tmp").exists(), "temp file must be renamed away");
    }

    #[test]
    fn write_replaces_existing_file_and_creates_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        DiscoveryInfo { port: 1, token: "x".into(), pid: 1, protocol_version: 1 }.write(&nested).unwrap();
        let second = DiscoveryInfo { port: 2, token: "y".into(), pid: 2, protocol_version: 1 };
        second.write(&nested).unwrap();
        assert_eq!(DiscoveryInfo::read(&nested).unwrap(), second);
    }

    #[test]
    fn read_missing_is_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(DiscoveryInfo::read(dir.path()).is_err());
    }
}
```

Modify `crates/protocol/src/lib.rs` — replace the top (above `#[cfg(test)]`) with:
```rust
//! Wire contract shared by hostd, the Tauri app, and (via ts-rs) the UI.

mod discovery;
mod frame;
mod messages;

pub use discovery::*;
pub use frame::*;
pub use messages::*;

/// Bump on any incompatible change to messages or frames.
pub const PROTOCOL_VERSION: u32 = 1;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p panehost-protocol`
Expected: compile errors — `encode_frame`, `decode_frame`, `DiscoveryInfo` not found.

- [ ] **Step 3: Implement**

Add above the test module in `crates/protocol/src/frame.rs`:
```rust
/// Binary frames carry terminal bytes: `[16-byte pane UUID][payload]`.
pub const FRAME_HEADER_LEN: usize = 16;

pub fn encode_frame(pane: &PaneId, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER_LEN + data.len());
    out.extend_from_slice(pane.as_bytes());
    out.extend_from_slice(data);
    out
}

pub fn decode_frame(frame: &[u8]) -> Option<(PaneId, &[u8])> {
    if frame.len() < FRAME_HEADER_LEN {
        return None;
    }
    let id = PaneId::from_slice(&frame[..FRAME_HEADER_LEN]).ok()?;
    Some((id, &frame[FRAME_HEADER_LEN..]))
}
```

Add above the test module in `crates/protocol/src/discovery.rs`:
```rust
use std::{fs, io};

use serde::{Deserialize, Serialize};

/// Overrides the data directory (used by tests and side-by-side dev instances).
pub const DATA_DIR_ENV: &str = "PANEHOST_DATA_DIR";

/// `%APPDATA%\Panehost`, unless `PANEHOST_DATA_DIR` is set.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV) {
        return PathBuf::from(dir);
    }
    dirs::data_dir().expect("%APPDATA% is not set").join("Panehost")
}

pub fn discovery_path(dir: &Path) -> PathBuf {
    dir.join("hostd.json")
}

/// Writes via a sibling temp file and rename so readers never see a partial file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

/// Written by hostd on startup; read by the app to find and authenticate to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub protocol_version: u32,
}

impl DiscoveryInfo {
    pub fn read(dir: &Path) -> io::Result<Self> {
        let bytes = fs::read(discovery_path(dir))?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn write(&self, dir: &Path) -> io::Result<()> {
        write_atomic(&discovery_path(dir), &serde_json::to_vec_pretty(self)?)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p panehost-protocol`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/protocol
git commit -m "feat(protocol): binary pane frames and atomic discovery file"
```

---

### Task 3: hostd crate — ring buffer and output coalescer

**Files:**
- Create: `crates/hostd/Cargo.toml`, `crates/hostd/src/lib.rs`, `crates/hostd/src/ring.rs`, `crates/hostd/src/coalesce.rs`

**Interfaces:**
- Produces: `hostd::ring::RingBuffer` with `fn new(cap: usize) -> Self`, `fn push(&mut self, data: &[u8])`, `fn snapshot(&self) -> Vec<u8>`, `fn len(&self) -> usize`, `fn is_empty(&self) -> bool`.
- Produces: `hostd::coalesce::next_batch(rx: &mut tokio::sync::mpsc::Receiver<Vec<u8>>, max: usize, window: Duration) -> Option<Vec<u8>>` (async).

- [ ] **Step 1: Create the crate**

`crates/hostd/Cargo.toml`:
```toml
[package]
name = "panehost-hostd"
version.workspace = true
edition.workspace = true

[lib]
name = "hostd"
path = "src/lib.rs"

[[bin]]
name = "panehost-hostd"
path = "src/main.rs"

[dependencies]
panehost-protocol = { path = "../protocol" }
tokio.workspace = true
serde_json.workspace = true
uuid.workspace = true
anyhow.workspace = true
tracing.workspace = true
bytes = "1"
portable-pty = "0.9"
axum = { version = "0.8", features = ["ws"] }
futures-util = "0.3"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
tracing-appender = "0.2"
windows-sys = { version = "0.61", features = ["Win32_Foundation", "Win32_Security", "Win32_System_Threading"] }

[dev-dependencies]
tokio = { workspace = true, features = ["test-util"] }
tokio-tungstenite = "0.30"
tempfile.workspace = true
```

`crates/hostd/src/lib.rs`:
```rust
//! panehost-hostd: owns terminal sessions so they outlive the UI.

pub mod coalesce;
pub mod ring;
```

`crates/hostd/src/main.rs` (placeholder so the `[[bin]]` target compiles; replaced in Task 7):
```rust
fn main() {}
```

- [ ] **Step 2: Write the failing tests**

`crates/hostd/src/ring.rs`:
```rust
use std::collections::VecDeque;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_under_capacity() {
        let mut ring = RingBuffer::new(8);
        ring.push(b"abc");
        ring.push(b"de");
        assert_eq!(ring.snapshot(), b"abcde");
        assert_eq!(ring.len(), 5);
    }

    #[test]
    fn drops_oldest_bytes_past_capacity() {
        let mut ring = RingBuffer::new(5);
        ring.push(b"abcd");
        ring.push(b"efg");
        assert_eq!(ring.snapshot(), b"cdefg");
    }

    #[test]
    fn oversized_push_keeps_only_the_tail() {
        let mut ring = RingBuffer::new(4);
        ring.push(b"ab");
        ring.push(b"0123456789");
        assert_eq!(ring.snapshot(), b"6789");
    }

    #[test]
    fn starts_empty() {
        let ring = RingBuffer::new(4);
        assert!(ring.is_empty());
        assert!(ring.snapshot().is_empty());
    }
}
```

`crates/hostd/src/coalesce.rs`:
```rust
use std::time::Duration;

use tokio::sync::mpsc::Receiver;
use tokio::time::{Instant, timeout_at};

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    const WINDOW: Duration = Duration::from_millis(8);

    #[tokio::test(start_paused = true)]
    async fn merges_chunks_already_queued() {
        let (tx, mut rx) = mpsc::channel(8);
        tx.send(b"ab".to_vec()).await.unwrap();
        tx.send(b"cd".to_vec()).await.unwrap();
        assert_eq!(next_batch(&mut rx, 1024, WINDOW).await, Some(b"abcd".to_vec()));
    }

    #[tokio::test(start_paused = true)]
    async fn stops_once_max_bytes_reached() {
        let (tx, mut rx) = mpsc::channel(8);
        for _ in 0..3 {
            tx.send(vec![1u8; 10]).await.unwrap();
        }
        assert_eq!(next_batch(&mut rx, 15, WINDOW).await.unwrap().len(), 20);
        assert_eq!(next_batch(&mut rx, 15, WINDOW).await.unwrap().len(), 10);
    }

    #[tokio::test(start_paused = true)]
    async fn chunk_after_window_goes_to_next_batch() {
        let (tx, mut rx) = mpsc::channel(8);
        tx.send(b"first".to_vec()).await.unwrap();
        let late = tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            late.send(b"late".to_vec()).await.unwrap();
        });
        assert_eq!(next_batch(&mut rx, 1024, WINDOW).await, Some(b"first".to_vec()));
        assert_eq!(next_batch(&mut rx, 1024, WINDOW).await, Some(b"late".to_vec()));
    }

    #[tokio::test(start_paused = true)]
    async fn none_after_channel_closed_and_drained() {
        let (tx, mut rx) = mpsc::channel(8);
        tx.send(b"x".to_vec()).await.unwrap();
        drop(tx);
        assert_eq!(next_batch(&mut rx, 1024, WINDOW).await, Some(b"x".to_vec()));
        assert_eq!(next_batch(&mut rx, 1024, WINDOW).await, None);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p panehost-hostd --lib`
Expected: compile errors — `RingBuffer`, `next_batch` not found.

- [ ] **Step 4: Implement**

Add above the test module in `crates/hostd/src/ring.rs`:
```rust
/// Fixed-capacity byte history; oldest bytes fall off the front.
pub struct RingBuffer {
    cap: usize,
    buf: VecDeque<u8>,
}

impl RingBuffer {
    pub fn new(cap: usize) -> Self {
        Self { cap, buf: VecDeque::with_capacity(cap.min(64 * 1024)) }
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        self.buf.drain(..overflow);
        self.buf.extend(data);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        let (a, b) = self.buf.as_slices();
        [a, b].concat()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}
```

Add above the test module in `crates/hostd/src/coalesce.rs`:
```rust
/// Waits for the next chunk, then keeps appending chunks that arrive within
/// `window` until the batch reaches `max` bytes. `None` once the channel is
/// closed and drained. Batching keeps frame count low during output floods.
pub async fn next_batch(rx: &mut Receiver<Vec<u8>>, max: usize, window: Duration) -> Option<Vec<u8>> {
    let mut batch = rx.recv().await?;
    let deadline = Instant::now() + window;
    while batch.len() < max {
        match timeout_at(deadline, rx.recv()).await {
            Ok(Some(chunk)) => batch.extend_from_slice(&chunk),
            Ok(None) | Err(_) => break,
        }
    }
    Some(batch)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p panehost-hostd --lib`
Expected: 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add Cargo.lock crates/hostd
git commit -m "feat(hostd): ring buffer and output batch coalescer"
```

---

### Task 4: Shell command builder

**Files:**
- Create: `crates/hostd/src/shell.rs`
- Modify: `crates/hostd/src/lib.rs` (add `pub mod shell;`)

**Interfaces:**
- Consumes: `SpawnRequest`, `PaneKind`, `ShellSpec` (Task 1).
- Produces: `struct ShellCommand { pub program: String, pub args: Vec<String> }`, `fn build_command(req: &SpawnRequest) -> ShellCommand`, `fn resolve_cwd(requested: &str) -> PathBuf`.

Rules: shell panes stay open after their command (`-NoExit`, `/K`, `exec bash -l`); claude panes run `claude` when no command is given and the shell exits with it, so the pane reports the agent's exit. A blank command counts as none.

- [ ] **Step 1: Write the failing tests**

`crates/hostd/src/shell.rs`:
```rust
use std::path::PathBuf;

use panehost_protocol::{PaneKind, ShellSpec, SpawnRequest};

#[cfg(test)]
mod tests {
    use super::*;

    fn req(kind: PaneKind, shell: ShellSpec, command: Option<&str>) -> SpawnRequest {
        SpawnRequest { title: "t".into(), cwd: String::new(), command: command.map(Into::into), kind, shell }
    }

    fn args(cmd: &ShellCommand) -> Vec<&str> {
        cmd.args.iter().map(String::as_str).collect()
    }

    #[test]
    fn powershell_without_command_is_interactive() {
        let cmd = build_command(&req(PaneKind::Shell, ShellSpec::Powershell, None));
        assert_eq!(cmd.program, "powershell.exe");
        assert_eq!(args(&cmd), ["-NoLogo"]);
    }

    #[test]
    fn powershell_command_keeps_shell_open() {
        let cmd = build_command(&req(PaneKind::Shell, ShellSpec::Powershell, Some("npm run dev")));
        assert_eq!(args(&cmd), ["-NoLogo", "-NoExit", "-Command", "npm run dev"]);
    }

    #[test]
    fn claude_defaults_to_claude_and_exits_with_it() {
        let cmd = build_command(&req(PaneKind::Claude, ShellSpec::Powershell, None));
        assert_eq!(args(&cmd), ["-NoLogo", "-Command", "claude"]);
    }

    #[test]
    fn claude_with_explicit_command() {
        let cmd = build_command(&req(PaneKind::Claude, ShellSpec::Powershell, Some("claude --continue")));
        assert_eq!(args(&cmd), ["-NoLogo", "-Command", "claude --continue"]);
    }

    #[test]
    fn blank_command_counts_as_none() {
        let cmd = build_command(&req(PaneKind::Shell, ShellSpec::Powershell, Some("   ")));
        assert_eq!(args(&cmd), ["-NoLogo"]);
    }

    #[test]
    fn cmd_uses_k_for_shells_and_c_for_claude() {
        let shell = build_command(&req(PaneKind::Shell, ShellSpec::Cmd, Some("dir")));
        assert_eq!(shell.program, "cmd.exe");
        assert_eq!(args(&shell), ["/K", "dir"]);
        let claude = build_command(&req(PaneKind::Claude, ShellSpec::Cmd, None));
        assert_eq!(args(&claude), ["/C", "claude"]);
    }

    #[test]
    fn wsl_with_distro_and_command() {
        let cmd = build_command(&req(
            PaneKind::Shell,
            ShellSpec::Wsl { distro: Some("Ubuntu".into()) },
            Some("npm run dev"),
        ));
        assert_eq!(cmd.program, "wsl.exe");
        assert_eq!(args(&cmd), ["-d", "Ubuntu", "--", "bash", "-lc", "npm run dev; exec bash -l"]);
    }

    #[test]
    fn wsl_default_distro_interactive() {
        let cmd = build_command(&req(PaneKind::Shell, ShellSpec::Wsl { distro: None }, None));
        assert!(cmd.args.is_empty());
    }

    #[test]
    fn resolve_cwd_blank_uses_profile_dir() {
        let expected = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
        assert_eq!(resolve_cwd("  "), expected);
    }

    #[test]
    fn resolve_cwd_trims() {
        assert_eq!(resolve_cwd("  C:\\work \t"), PathBuf::from("C:\\work"));
    }
}
```

Add `pub mod shell;` to `crates/hostd/src/lib.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p panehost-hostd --lib shell`
Expected: compile errors — `build_command`, `ShellCommand`, `resolve_cwd` not found.

- [ ] **Step 3: Implement**

Add above the test module in `crates/hostd/src/shell.rs`:
```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Translates a spawn request into the process to run inside the PTY.
/// portable-pty quotes each arg for the Windows command line.
pub fn build_command(req: &SpawnRequest) -> ShellCommand {
    let command = match (&req.command, &req.kind) {
        (Some(c), _) if !c.trim().is_empty() => Some(c.trim().to_string()),
        (_, PaneKind::Claude) => Some("claude".to_string()),
        _ => None,
    };
    let keep_open = req.kind == PaneKind::Shell;

    match &req.shell {
        ShellSpec::Powershell => {
            let mut args = vec!["-NoLogo".to_string()];
            if let Some(c) = command {
                if keep_open {
                    args.push("-NoExit".into());
                }
                args.push("-Command".into());
                args.push(c);
            }
            ShellCommand { program: "powershell.exe".into(), args }
        }
        ShellSpec::Cmd => {
            let mut args = Vec::new();
            if let Some(c) = command {
                args.push(if keep_open { "/K" } else { "/C" }.to_string());
                args.push(c);
            }
            ShellCommand { program: "cmd.exe".into(), args }
        }
        ShellSpec::Wsl { distro } => {
            let mut args = Vec::new();
            if let Some(d) = distro {
                args.push("-d".into());
                args.push(d.clone());
            }
            if let Some(c) = command {
                let script = if keep_open { format!("{c}; exec bash -l") } else { c };
                args.extend(["--".into(), "bash".into(), "-lc".into(), script]);
            }
            ShellCommand { program: "wsl.exe".into(), args }
        }
    }
}

/// Blank means the user's profile directory.
pub fn resolve_cwd(requested: &str) -> PathBuf {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\"))
    } else {
        PathBuf::from(trimmed)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p panehost-hostd --lib shell`
Expected: 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/hostd
git commit -m "feat(hostd): shell command builder for powershell, cmd, wsl"
```

---

### Task 5: Pane registry — PTY lifecycle, pumps, events

**Files:**
- Create: `crates/hostd/src/registry.rs`
- Modify: `crates/hostd/src/lib.rs` (add `pub mod registry;`)
- Test: `crates/hostd/tests/registry.rs`

**Interfaces:**
- Consumes: `RingBuffer` (Task 3), `next_batch` (Task 3), `build_command`, `resolve_cwd` (Task 4), protocol types.
- Produces (`hostd::registry`):
  - `pub struct RegistryConfig { pub ring_capacity: usize, pub env: Vec<(String, String)> }`
  - `pub const DEFAULT_COLS: u16 = 120; pub const DEFAULT_ROWS: u16 = 32;`
  - `impl Registry`: `fn new(config: RegistryConfig) -> Arc<Registry>` (must be called inside a tokio runtime), `fn subscribe_events(&self) -> broadcast::Receiver<ServerMsg>`, `fn list(&self) -> Vec<PaneInfo>`, `fn get(&self, id: PaneId) -> Option<Arc<Pane>>`, `fn spawn(self: &Arc<Self>, req: SpawnRequest) -> PaneInfo`, `fn write(&self, id: PaneId, data: &[u8]) -> anyhow::Result<()>`, `fn resize(&self, id: PaneId, cols: u16, rows: u16) -> anyhow::Result<()>`, `fn kill(&self, id: PaneId) -> anyhow::Result<()>`, `fn remove(&self, id: PaneId) -> anyhow::Result<()>`.
  - `impl Pane`: `fn id(&self) -> PaneId`, `fn info(&self) -> PaneInfo`, `fn attach(&self) -> (Vec<u8>, broadcast::Receiver<bytes::Bytes>)` (history snapshot + live stream, atomic: no gap, no duplicate), `fn write(&self, data: &[u8])`, `fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()>`, `fn kill(&self) -> anyhow::Result<()>`.
  - Events emitted: `PaneAdded` on spawn, `PaneUpdated` on status change, `PaneRemoved` on remove.

Design notes for the implementer:
- A failed spawn (bad cwd, missing program) still creates a pane, with `status: Error{message}` and no I/O — the UI shows the error inline.
- Background work per pane: a **reader thread** (blocking PTY reads → tokio mpsc), a **coalescer task** (`next_batch` → ring + broadcast), a **writer thread** (std mpsc → PTY), an **exit-watcher thread** (`child.wait()` → `Exited{code}`).
- The coalescer and exit watcher hold `Weak` refs so removing a pane actually drops it (dropping the master closes the pseudoconsole, which ends the reader thread).
- `kill` terminates the shell **and** drops the PTY master: closing the pseudoconsole ends every process still attached to it (e.g. a dev server started from that shell).

- [ ] **Step 1: Write the failing integration tests**

`crates/hostd/tests/registry.rs`:
```rust
use std::sync::Arc;
use std::time::Duration;

use hostd::registry::{Pane, Registry, RegistryConfig};
use panehost_protocol::{PaneId, PaneKind, PaneStatus, ServerMsg, ShellSpec, SpawnRequest};
use tokio::sync::broadcast::error::RecvError;
use tokio::time::timeout;

fn registry() -> Arc<Registry> {
    Registry::new(RegistryConfig {
        ring_capacity: 1 << 20,
        env: vec![("PANEHOST_TEST_VAR".into(), "from-registry".into())],
    })
}

fn cmd_request(kind: PaneKind, command: Option<&str>) -> SpawnRequest {
    SpawnRequest {
        title: "t".into(),
        cwd: std::env::temp_dir().display().to_string(),
        command: command.map(Into::into),
        kind,
        shell: ShellSpec::Cmd,
    }
}

async fn output_until(pane: &Arc<Pane>, needle: &str) -> String {
    let (snapshot, mut rx) = pane.attach();
    let mut text = String::from_utf8_lossy(&snapshot).into_owned();
    timeout(Duration::from_secs(15), async {
        while !text.contains(needle) {
            match rx.recv().await {
                Ok(bytes) => text.push_str(&String::from_utf8_lossy(&bytes)),
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}; got {text:?}"));
    text
}

async fn status_until(reg: &Registry, id: PaneId, pred: impl Fn(&PaneStatus) -> bool) -> PaneStatus {
    timeout(Duration::from_secs(15), async {
        loop {
            let status = reg.get(id).expect("pane exists").info().status;
            if pred(&status) {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("timed out waiting for status")
}

#[tokio::test(flavor = "multi_thread")]
async fn output_env_and_exit_code_reach_the_pane() {
    let reg = registry();
    let info = reg.spawn(cmd_request(PaneKind::Claude, Some("echo %PANEHOST_TEST_VAR% %PANEHOST_PANE_ID%")));
    assert_eq!(info.status, PaneStatus::Running);
    let pane = reg.get(info.id).unwrap();
    let text = output_until(&pane, &info.id.to_string()).await;
    assert!(text.contains("from-registry"), "configured env missing: {text:?}");
    let status = status_until(&reg, info.id, |s| matches!(s, PaneStatus::Exited { .. })).await;
    assert_eq!(status, PaneStatus::Exited { code: 0 });
}

#[tokio::test(flavor = "multi_thread")]
async fn input_is_written_to_the_process() {
    let reg = registry();
    let info = reg.spawn(cmd_request(PaneKind::Shell, None));
    reg.write(info.id, b"echo typed-%OS%\r").unwrap();
    // %OS% expands only in the output, never in the echoed input line.
    output_until(&reg.get(info.id).unwrap(), "typed-Windows_NT").await;
    reg.kill(info.id).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_cwd_yields_error_pane() {
    let reg = registry();
    let mut req = cmd_request(PaneKind::Shell, None);
    req.cwd = "C:\\definitely\\missing\\panehost-dir".into();
    let info = reg.spawn(req);
    match info.status {
        PaneStatus::Error { message } => assert!(message.contains("working directory not found"), "{message}"),
        other => panic!("expected error status, got {other:?}"),
    }
    assert_eq!(reg.list().len(), 1, "error panes stay listed so the UI can show them");
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_marks_pane_exited() {
    let reg = registry();
    let info = reg.spawn(cmd_request(PaneKind::Shell, None));
    reg.kill(info.id).unwrap();
    status_until(&reg, info.id, |s| matches!(s, PaneStatus::Exited { .. })).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_and_remove_emit_events() {
    let reg = registry();
    let mut events = reg.subscribe_events();
    let info = reg.spawn(cmd_request(PaneKind::Shell, None));
    reg.remove(info.id).unwrap();
    assert!(reg.list().is_empty());
    assert!(reg.get(info.id).is_none());
    let mut saw_added = false;
    timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await.unwrap() {
                ServerMsg::PaneAdded { pane } if pane.id == info.id => saw_added = true,
                ServerMsg::PaneRemoved { pane } if pane == info.id => break,
                _ => {}
            }
        }
    })
    .await
    .expect("PaneRemoved not emitted");
    assert!(saw_added);
}
```

Add `pub mod registry;` to `crates/hostd/src/lib.rs` and create an empty `crates/hostd/src/registry.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p panehost-hostd --test registry`
Expected: compile errors — `Registry`, `RegistryConfig`, `Pane` not found.

- [ ] **Step 3: Implement the registry**

`crates/hostd/src/registry.rs`:
```rust
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock, Weak, mpsc as std_mpsc};
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use panehost_protocol::{PaneId, PaneInfo, PaneStatus, ServerMsg, SpawnRequest};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::coalesce::next_batch;
use crate::ring::RingBuffer;
use crate::shell::{build_command, resolve_cwd};

pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 32;
/// 64 batches × ≤16 KB ≈ 1 MB of lag before a client is resynced from the ring.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;
const EVENT_CHANNEL_CAPACITY: usize = 256;
const BATCH_MAX_BYTES: usize = 16 * 1024;
const BATCH_WINDOW: Duration = Duration::from_millis(8);

pub struct RegistryConfig {
    pub ring_capacity: usize,
    /// Extra environment for every PTY (hostd port/token for the Claude hook).
    pub env: Vec<(String, String)>,
}

pub struct Registry {
    config: RegistryConfig,
    panes: RwLock<Vec<Arc<Pane>>>,
    events: broadcast::Sender<ServerMsg>,
    runtime: tokio::runtime::Handle,
}

pub struct Pane {
    id: PaneId,
    info: Mutex<PaneInfo>,
    output: Mutex<Output>,
    io: Option<PaneIo>,
}

/// Ring and broadcast sender share one lock so attach() can snapshot + subscribe atomically.
struct Output {
    ring: RingBuffer,
    tx: broadcast::Sender<Bytes>,
}

struct PaneIo {
    input: std_mpsc::Sender<Vec<u8>>,
    /// Taken (dropped) on kill: closing the pseudoconsole ends every attached process.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

struct Started {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Registry {
    /// Must be called from inside a tokio runtime.
    pub fn new(config: RegistryConfig) -> Arc<Self> {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Arc::new(Self {
            config,
            panes: RwLock::new(Vec::new()),
            events,
            runtime: tokio::runtime::Handle::current(),
        })
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<ServerMsg> {
        self.events.subscribe()
    }

    pub fn list(&self) -> Vec<PaneInfo> {
        self.panes.read().unwrap().iter().map(|p| p.info()).collect()
    }

    pub fn get(&self, id: PaneId) -> Option<Arc<Pane>> {
        self.panes.read().unwrap().iter().find(|p| p.id == id).cloned()
    }

    pub fn spawn(self: &Arc<Self>, req: SpawnRequest) -> PaneInfo {
        let id = Uuid::new_v4();
        let cwd = resolve_cwd(&req.cwd);
        let mut info = PaneInfo {
            id,
            title: req.title.clone(),
            cwd: cwd.display().to_string(),
            command: req.command.clone(),
            kind: req.kind.clone(),
            shell: req.shell.clone(),
            status: PaneStatus::Running,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        };

        let (io, pumps) = match self.start_process(id, &req, &cwd) {
            Ok(s) => {
                let (input_tx, input_rx) = std_mpsc::channel();
                let io = PaneIo {
                    input: input_tx,
                    killer: Mutex::new(s.child.clone_killer()),
                    master: Mutex::new(Some(s.master)),
                };
                (Some(io), Some((s.reader, s.writer, s.child, input_rx)))
            }
            Err(e) => {
                tracing::warn!(%id, error = %format!("{e:#}"), "pane failed to start");
                info.status = PaneStatus::Error { message: format!("{e:#}") };
                (None, None)
            }
        };

        let (tx, _) = broadcast::channel(OUTPUT_CHANNEL_CAPACITY);
        let pane = Arc::new(Pane {
            id,
            info: Mutex::new(info.clone()),
            output: Mutex::new(Output { ring: RingBuffer::new(self.config.ring_capacity), tx }),
            io,
        });
        self.panes.write().unwrap().push(pane.clone());
        let _ = self.events.send(ServerMsg::PaneAdded { pane: info.clone() });

        if let Some((reader, writer, child, input_rx)) = pumps {
            self.start_pumps(&pane, reader, writer, child, input_rx);
        }
        info
    }

    pub fn write(&self, id: PaneId, data: &[u8]) -> Result<()> {
        self.get(id).with_context(|| format!("unknown pane {id}"))?.write(data);
        Ok(())
    }

    pub fn resize(&self, id: PaneId, cols: u16, rows: u16) -> Result<()> {
        self.get(id).with_context(|| format!("unknown pane {id}"))?.resize(cols, rows)
    }

    pub fn kill(&self, id: PaneId) -> Result<()> {
        self.get(id).with_context(|| format!("unknown pane {id}"))?.kill()
    }

    pub fn remove(&self, id: PaneId) -> Result<()> {
        let pane = {
            let mut panes = self.panes.write().unwrap();
            let idx = panes.iter().position(|p| p.id == id).with_context(|| format!("unknown pane {id}"))?;
            panes.remove(idx)
        };
        pane.kill()?;
        let _ = self.events.send(ServerMsg::PaneRemoved { pane: id });
        Ok(())
    }

    fn set_status(&self, id: PaneId, status: PaneStatus) {
        let Some(pane) = self.get(id) else { return };
        let info = {
            let mut info = pane.info.lock().unwrap();
            info.status = status;
            info.clone()
        };
        let _ = self.events.send(ServerMsg::PaneUpdated { pane: info });
    }

    fn start_process(&self, id: PaneId, req: &SpawnRequest, cwd: &Path) -> Result<Started> {
        anyhow::ensure!(cwd.is_dir(), "working directory not found: {}", cwd.display());
        let pair = native_pty_system()
            .openpty(PtySize { rows: DEFAULT_ROWS, cols: DEFAULT_COLS, pixel_width: 0, pixel_height: 0 })
            .context("failed to open pseudoconsole")?;

        let shell = build_command(req);
        let mut cmd = CommandBuilder::new(&shell.program);
        cmd.args(&shell.args);
        cmd.cwd(cwd);
        cmd.env("PANEHOST_PANE_ID", id.to_string());
        for (key, value) in &self.config.env {
            cmd.env(key, value);
        }

        let child = pair.slave.spawn_command(cmd).with_context(|| format!("failed to start {}", shell.program))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().context("failed to open PTY reader")?;
        let writer = pair.master.take_writer().context("failed to open PTY writer")?;
        Ok(Started { master: pair.master, reader, writer, child })
    }

    fn start_pumps(
        self: &Arc<Self>,
        pane: &Arc<Pane>,
        mut reader: Box<dyn Read + Send>,
        mut writer: Box<dyn Write + Send>,
        mut child: Box<dyn Child + Send + Sync>,
        input_rx: std_mpsc::Receiver<Vec<u8>>,
    ) {
        let id = pane.id;

        let (chunk_tx, mut chunk_rx) = mpsc::channel::<Vec<u8>>(64);
        std::thread::Builder::new()
            .name(format!("pty-read-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if chunk_tx.blocking_send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .expect("spawn PTY reader thread");

        let weak_pane = Arc::downgrade(pane);
        self.runtime.spawn(async move {
            while let Some(batch) = next_batch(&mut chunk_rx, BATCH_MAX_BYTES, BATCH_WINDOW).await {
                let Some(pane) = weak_pane.upgrade() else { break };
                pane.publish(&batch);
            }
        });

        std::thread::Builder::new()
            .name(format!("pty-write-{id}"))
            .spawn(move || {
                for data in input_rx {
                    if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
                        break;
                    }
                }
            })
            .expect("spawn PTY writer thread");

        let registry: Weak<Registry> = Arc::downgrade(self);
        std::thread::Builder::new()
            .name(format!("pty-exit-{id}"))
            .spawn(move || {
                let code = child.wait().map(|s| s.exit_code()).unwrap_or(u32::MAX);
                tracing::info!(%id, code, "pane process exited");
                if let Some(registry) = registry.upgrade() {
                    registry.set_status(id, PaneStatus::Exited { code });
                }
            })
            .expect("spawn PTY exit watcher");
    }
}

impl Pane {
    pub fn id(&self) -> PaneId {
        self.id
    }

    pub fn info(&self) -> PaneInfo {
        self.info.lock().unwrap().clone()
    }

    /// History snapshot plus a live receiver, taken under one lock: no gap, no duplicate.
    pub fn attach(&self) -> (Vec<u8>, broadcast::Receiver<Bytes>) {
        let out = self.output.lock().unwrap();
        (out.ring.snapshot(), out.tx.subscribe())
    }

    pub fn write(&self, data: &[u8]) {
        if let Some(io) = &self.io {
            let _ = io.input.send(data.to_vec());
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        anyhow::ensure!(cols > 0 && rows > 0, "invalid size {cols}x{rows}");
        let Some(io) = &self.io else { return Ok(()) };
        if let Some(master) = io.master.lock().unwrap().as_ref() {
            master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        }
        let mut info = self.info.lock().unwrap();
        info.cols = cols;
        info.rows = rows;
        Ok(())
    }

    pub fn kill(&self) -> Result<()> {
        let Some(io) = &self.io else { return Ok(()) };
        if matches!(self.info().status, PaneStatus::Running) {
            if let Err(e) = io.killer.lock().unwrap().kill() {
                tracing::debug!(id = %self.id, error = %e, "kill failed (process may have exited)");
            }
        }
        io.master.lock().unwrap().take();
        Ok(())
    }

    fn publish(&self, data: &[u8]) {
        let mut out = self.output.lock().unwrap();
        out.ring.push(data);
        let _ = out.tx.send(Bytes::copy_from_slice(data));
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p panehost-hostd --test registry`
Expected: 5 tests PASS. If `output_env_and_exit_code_reach_the_pane` times out, print the captured `text` — ConPTY occasionally inserts cursor-movement sequences; the needles are chosen to be short and unbroken, so a failure here indicates a real read-path bug, not flakiness.

- [ ] **Step 5: Run the whole crate's tests**

Run: `cargo test -p panehost-hostd`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/hostd
git commit -m "feat(hostd): pane registry with ConPTY lifecycle and output fan-out"
```

---

### Task 6: WebSocket server — handshake, control dispatch, attach streaming

**Files:**
- Create: `crates/hostd/src/server.rs`, `crates/hostd/src/connection.rs`
- Modify: `crates/hostd/src/lib.rs` (add `pub mod server; mod connection;`)
- Test: `crates/hostd/tests/server.rs`

**Interfaces:**
- Consumes: `Registry`, `Pane` (Task 5), protocol messages + frames (Tasks 1–2).
- Produces (`hostd::server`): `pub struct ServerState { pub registry: Arc<Registry>, pub token: String }`, `pub fn router(state: Arc<ServerState>) -> axum::Router`, `pub async fn serve(listener: tokio::net::TcpListener, state: Arc<ServerState>) -> std::io::Result<()>`. Route: `GET /ws`.

Connection protocol:
1. First frame must be text `Hello` with the right token within 5 s, else the socket closes. Wrong `protocol_version` → send `VersionMismatch{server_version}` and close.
2. Subscribe to registry events **before** sending `Welcome{protocol_version, panes}` (so nothing is missed; clients upsert, so a duplicate `PaneAdded` is harmless). If the event receiver lags, send a fresh `Welcome`.
3. `Attach{pane, cols, rows}` → binary frame `ESC c` + ring snapshot, then a redraw nudge (resize to `cols-1`, 50 ms, then `cols`), then live output. On lag: reset + replay again. Re-attaching the same pane replaces the previous stream.
4. Binary frames from the client are input for the pane in their header.
5. Errors from control messages are reported as `ServerMsg::Error{message}`; the connection stays open.

- [ ] **Step 1: Write the failing integration tests**

`crates/hostd/tests/server.rs`:
```rust
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use hostd::registry::{Registry, RegistryConfig};
use hostd::server::{ServerState, serve};
use panehost_protocol::{
    ClientMsg, PROTOCOL_VERSION, PaneId, PaneKind, PaneStatus, ServerMsg, ShellSpec, SpawnRequest, decode_frame,
    encode_frame,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const TOKEN: &str = "test-token";
type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start() -> SocketAddr {
    let registry = Registry::new(RegistryConfig { ring_capacity: 1 << 20, env: vec![] });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(ServerState { registry, token: TOKEN.into() });
    tokio::spawn(async move { serve(listener, state).await });
    addr
}

async fn connect(addr: SocketAddr) -> Ws {
    connect_async(format!("ws://{addr}/ws")).await.unwrap().0
}

async fn send(ws: &mut Ws, msg: &ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap())).await.unwrap();
}

async fn next_msg(ws: &mut Ws) -> ServerMsg {
    timeout(Duration::from_secs(10), async {
        loop {
            match ws.next().await.expect("socket closed").expect("socket error") {
                Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
                _ => continue,
            }
        }
    })
    .await
    .expect("timed out waiting for a control message")
}

async fn hello(ws: &mut Ws) -> Vec<panehost_protocol::PaneInfo> {
    send(ws, &ClientMsg::Hello { token: TOKEN.into(), protocol_version: PROTOCOL_VERSION }).await;
    match next_msg(ws).await {
        ServerMsg::Welcome { protocol_version, panes } => {
            assert_eq!(protocol_version, PROTOCOL_VERSION);
            panes
        }
        other => panic!("expected Welcome, got {other:?}"),
    }
}

async fn spawn_cmd(ws: &mut Ws) -> PaneId {
    let request = SpawnRequest {
        title: "cmd".into(),
        cwd: std::env::temp_dir().display().to_string(),
        command: None,
        kind: PaneKind::Shell,
        shell: ShellSpec::Cmd,
    };
    send(ws, &ClientMsg::Spawn { request }).await;
    loop {
        if let ServerMsg::PaneAdded { pane } = next_msg(ws).await {
            return pane.id;
        }
    }
}

/// Returns (first frame payload for the pane, accumulated text once `needle` seen).
async fn output_until(ws: &mut Ws, pane: PaneId, needle: &str) -> (Vec<u8>, String) {
    let mut first: Option<Vec<u8>> = None;
    let mut text = String::new();
    timeout(Duration::from_secs(15), async {
        while !text.contains(needle) {
            if let Message::Binary(data) = ws.next().await.expect("socket closed").expect("socket error") {
                let (id, payload) = decode_frame(&data).expect("valid frame");
                if id == pane {
                    first.get_or_insert_with(|| payload.to_vec());
                    text.push_str(&String::from_utf8_lossy(payload));
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}; got {text:?}"));
    (first.unwrap(), text)
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_token_is_disconnected_without_welcome() {
    let addr = start().await;
    let mut ws = connect(addr).await;
    send(&mut ws, &ClientMsg::Hello { token: "wrong".into(), protocol_version: PROTOCOL_VERSION }).await;
    let next = timeout(Duration::from_secs(5), ws.next()).await.expect("server should close promptly");
    assert!(!matches!(next, Some(Ok(Message::Text(_)))), "must not receive control messages: {next:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn non_hello_first_frame_is_disconnected() {
    let addr = start().await;
    let mut ws = connect(addr).await;
    send(&mut ws, &ClientMsg::Kill { pane: PaneId::nil() }).await;
    let next = timeout(Duration::from_secs(5), ws.next()).await.expect("server should close promptly");
    assert!(!matches!(next, Some(Ok(Message::Text(_)))));
}

#[tokio::test(flavor = "multi_thread")]
async fn version_mismatch_is_reported() {
    let addr = start().await;
    let mut ws = connect(addr).await;
    send(&mut ws, &ClientMsg::Hello { token: TOKEN.into(), protocol_version: PROTOCOL_VERSION + 1 }).await;
    assert_eq!(next_msg(&mut ws).await, ServerMsg::VersionMismatch { server_version: PROTOCOL_VERSION });
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_attach_input_and_reattach_replay() {
    let addr = start().await;
    let mut ws = connect(addr).await;
    assert!(hello(&mut ws).await.is_empty());
    let pane = spawn_cmd(&mut ws).await;

    send(&mut ws, &ClientMsg::Attach { pane, cols: 100, rows: 30 }).await;
    ws.send(Message::binary(encode_frame(&pane, b"echo ws-%OS%\r"))).await.unwrap();
    let (first, _) = output_until(&mut ws, pane, "ws-Windows_NT").await;
    assert!(first.starts_with(b"\x1bc"), "attach must begin with a terminal reset");

    // A second client (e.g. the window reopened) gets history replayed.
    let mut ws2 = connect(addr).await;
    let panes = hello(&mut ws2).await;
    assert_eq!(panes.len(), 1);
    assert_eq!(panes[0].id, pane);
    send(&mut ws2, &ClientMsg::Attach { pane, cols: 100, rows: 30 }).await;
    let (replay, _) = output_until(&mut ws2, pane, "ws-Windows_NT").await;
    assert!(replay.starts_with(b"\x1bc"));
    assert!(String::from_utf8_lossy(&replay).contains("ws-Windows_NT"), "history must be in the first frame");
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_then_remove_broadcast_updates() {
    let addr = start().await;
    let mut ws = connect(addr).await;
    hello(&mut ws).await;
    let pane = spawn_cmd(&mut ws).await;

    send(&mut ws, &ClientMsg::Kill { pane }).await;
    loop {
        if let ServerMsg::PaneUpdated { pane: info } = next_msg(&mut ws).await {
            if info.id == pane && matches!(info.status, PaneStatus::Exited { .. }) {
                break;
            }
        }
    }
    send(&mut ws, &ClientMsg::Remove { pane }).await;
    loop {
        if let ServerMsg::PaneRemoved { pane: id } = next_msg(&mut ws).await {
            assert_eq!(id, pane);
            break;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn control_errors_are_reported_not_fatal() {
    let addr = start().await;
    let mut ws = connect(addr).await;
    hello(&mut ws).await;
    send(&mut ws, &ClientMsg::Kill { pane: PaneId::nil() }).await;
    assert!(matches!(next_msg(&mut ws).await, ServerMsg::Error { .. }));
    // Still usable afterwards.
    spawn_cmd(&mut ws).await;
}
```

Add to `crates/hostd/src/lib.rs`:
```rust
mod connection;
pub mod registry;
pub mod server;
```
(keep the existing `coalesce`, `ring`, `shell` lines) and create empty `server.rs` / `connection.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p panehost-hostd --test server`
Expected: compile errors — `ServerState`, `serve` not found.

- [ ] **Step 3: Implement the server**

`crates/hostd/src/server.rs`:
```rust
use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::WebSocketUpgrade;
use axum::response::Response;
use axum::routing::get;

use crate::registry::Registry;

pub struct ServerState {
    pub registry: Arc<Registry>,
    pub token: String,
}

pub fn router(state: Arc<ServerState>) -> Router {
    Router::new().route("/ws", get(ws_handler)).with_state(state)
}

pub async fn serve(listener: tokio::net::TcpListener, state: Arc<ServerState>) -> std::io::Result<()> {
    axum::serve(listener, router(state)).await
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<ServerState>>) -> Response {
    ws.on_upgrade(move |socket| crate::connection::run(socket, state))
}
```

`crates/hostd/src/connection.rs`:
```rust
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use panehost_protocol::{ClientMsg, PROTOCOL_VERSION, PaneId, ServerMsg, decode_frame, encode_frame};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::registry::Pane;
use crate::server::ServerState;

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const OUTBOUND_CAPACITY: usize = 256;
const RESET: &[u8] = b"\x1bc";

type Outbound = mpsc::Sender<Message>;

pub async fn run(mut socket: WebSocket, state: Arc<ServerState>) {
    if !handshake(&mut socket, &state).await {
        return;
    }

    let mut events = state.registry.subscribe_events();
    let (mut sink, mut stream) = socket.split();
    let (out, mut out_rx) = mpsc::channel::<Message>(OUTBOUND_CAPACITY);
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let _ = out.send(text(&welcome(&state))).await;

    let events_out = out.clone();
    let events_state = state.clone();
    let events_task = tokio::spawn(async move {
        loop {
            let msg = match events.recv().await {
                Ok(msg) => msg,
                Err(RecvError::Lagged(_)) => welcome(&events_state),
                Err(RecvError::Closed) => break,
            };
            if events_out.send(text(&msg)).await.is_err() {
                break;
            }
        }
    });

    let mut attachments: HashMap<PaneId, AbortHandle> = HashMap::new();
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(data) => {
                if let Some((pane, input)) = decode_frame(&data) {
                    let _ = state.registry.write(pane, input);
                }
            }
            Message::Text(t) => match serde_json::from_str::<ClientMsg>(t.as_str()) {
                Ok(cmd) => {
                    if let Err(e) = dispatch(cmd, &state, &out, &mut attachments) {
                        let _ = out.send(text(&ServerMsg::Error { message: format!("{e:#}") })).await;
                    }
                }
                Err(e) => {
                    let _ = out.send(text(&ServerMsg::Error { message: format!("bad message: {e}") })).await;
                }
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    for handle in attachments.into_values() {
        handle.abort();
    }
    events_task.abort();
    writer.abort();
}

/// True when the client authenticated with a compatible protocol version.
async fn handshake(socket: &mut WebSocket, state: &ServerState) -> bool {
    let first = tokio::time::timeout(HELLO_TIMEOUT, socket.recv()).await;
    let hello = match first {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<ClientMsg>(t.as_str()).ok(),
        _ => None,
    };
    match hello {
        Some(ClientMsg::Hello { token, protocol_version }) if token == state.token => {
            if protocol_version == PROTOCOL_VERSION {
                return true;
            }
            let _ = socket.send(text(&ServerMsg::VersionMismatch { server_version: PROTOCOL_VERSION })).await;
            false
        }
        _ => {
            tracing::warn!("rejected WebSocket: missing or invalid Hello");
            false
        }
    }
}

fn dispatch(
    cmd: ClientMsg,
    state: &ServerState,
    out: &Outbound,
    attachments: &mut HashMap<PaneId, AbortHandle>,
) -> Result<()> {
    match cmd {
        ClientMsg::Hello { .. } => Ok(()),
        ClientMsg::Spawn { request } => {
            // PaneAdded reaches this client through the event stream.
            state.registry.spawn(request);
            Ok(())
        }
        ClientMsg::Attach { pane, cols, rows } => attach(state, out, attachments, pane, cols, rows),
        ClientMsg::Detach { pane } => {
            if let Some(handle) = attachments.remove(&pane) {
                handle.abort();
            }
            Ok(())
        }
        ClientMsg::Resize { pane, cols, rows } => state.registry.resize(pane, cols, rows),
        ClientMsg::Kill { pane } => state.registry.kill(pane),
        ClientMsg::Remove { pane } => {
            if let Some(handle) = attachments.remove(&pane) {
                handle.abort();
            }
            state.registry.remove(pane)
        }
    }
}

fn attach(
    state: &ServerState,
    out: &Outbound,
    attachments: &mut HashMap<PaneId, AbortHandle>,
    id: PaneId,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let pane = state.registry.get(id).with_context(|| format!("unknown pane {id}"))?;
    if let Some(previous) = attachments.remove(&id) {
        previous.abort();
    }
    let (snapshot, live) = pane.attach();
    let task = tokio::spawn(stream_pane(Arc::downgrade(&pane), id, cols, rows, snapshot, live, out.clone()));
    attachments.insert(id, task.abort_handle());
    Ok(())
}

/// Holds only a Weak<Pane> so a removed pane is dropped even while clients are attached.
async fn stream_pane(
    pane: Weak<Pane>,
    id: PaneId,
    cols: u16,
    rows: u16,
    snapshot: Vec<u8>,
    mut live: broadcast::Receiver<Bytes>,
    out: Outbound,
) {
    if send_replay(&out, id, snapshot).await.is_err() {
        return;
    }
    redraw_nudge(&pane, cols, rows).await;
    loop {
        match live.recv().await {
            Ok(bytes) => {
                if out.send(Message::Binary(encode_frame(&id, &bytes).into())).await.is_err() {
                    return;
                }
            }
            Err(RecvError::Lagged(skipped)) => {
                tracing::debug!(%id, skipped, "client fell behind; resyncing from ring buffer");
                let Some(p) = pane.upgrade() else { return };
                let (snapshot, rx) = p.attach();
                drop(p);
                live = rx;
                if send_replay(&out, id, snapshot).await.is_err() {
                    return;
                }
            }
            Err(RecvError::Closed) => return,
        }
    }
}

async fn send_replay(out: &Outbound, id: PaneId, snapshot: Vec<u8>) -> Result<(), ()> {
    let mut data = Vec::with_capacity(RESET.len() + snapshot.len());
    data.extend_from_slice(RESET);
    data.extend_from_slice(&snapshot);
    out.send(Message::Binary(encode_frame(&id, &data).into())).await.map_err(|_| ())
}

/// Shrinking by one column and restoring forces full-screen TUIs (Claude) to repaint
/// cleanly over the replayed history; plain shells are unaffected.
async fn redraw_nudge(pane: &Weak<Pane>, cols: u16, rows: u16) {
    if cols < 2 || rows < 1 {
        return;
    }
    if let Some(p) = pane.upgrade() {
        let _ = p.resize(cols - 1, rows);
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    if let Some(p) = pane.upgrade() {
        let _ = p.resize(cols, rows);
    }
}

fn welcome(state: &ServerState) -> ServerMsg {
    ServerMsg::Welcome { protocol_version: PROTOCOL_VERSION, panes: state.registry.list() }
}

fn text(msg: &ServerMsg) -> Message {
    Message::Text(serde_json::to_string(msg).expect("ServerMsg serializes").into())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p panehost-hostd --test server`
Expected: 6 tests PASS.

- [ ] **Step 5: Run the whole crate and clippy**

Run: `cargo test -p panehost-hostd && cargo clippy -p panehost-hostd --all-targets -- -D warnings`
Expected: all PASS, no clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add crates/hostd
git commit -m "feat(hostd): authenticated WebSocket server with attach replay and resync"
```

---

### Task 7: hostd binary — logging, single instance, discovery

**Files:**
- Create: `crates/hostd/src/logging.rs`, `crates/hostd/src/instance.rs`
- Modify: `crates/hostd/src/main.rs` (replace placeholder), `crates/hostd/src/lib.rs` (add `pub mod instance; pub mod logging;`)
- Test: `crates/hostd/tests/binary.rs`

**Interfaces:**
- Consumes: `data_dir`, `DiscoveryInfo`, `PROTOCOL_VERSION` (Task 2); `Registry` (Task 5); `ServerState`, `serve` (Task 6).
- Produces: executable `panehost-hostd.exe`. On start: logs to `<data dir>\logs\hostd.YYYY-MM-DD.log` (7 days kept; level via env `PANEHOST_LOG`, default `info`), acquires `Local\PanehostHostd-<hash>` (exits 0 if already held), binds `127.0.0.1:0`, writes `hostd.json`, serves until killed. Release builds have no console window.
- Produces: `hostd::instance::acquire(dir: &Path) -> Option<InstanceGuard>`, `hostd::logging::init(dir: &Path) -> tracing_appender::non_blocking::WorkerGuard`.

- [ ] **Step 1: Write the failing test**

`crates/hostd/tests/binary.rs`:
```rust
use std::net::TcpStream;
use std::process::Command;
use std::time::{Duration, Instant};

use panehost_protocol::{DiscoveryInfo, PROTOCOL_VERSION};

const EXE: &str = env!("CARGO_BIN_EXE_panehost-hostd");

#[test]
fn writes_discovery_accepts_connections_and_is_single_instance() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(EXE).env("PANEHOST_DATA_DIR", dir.path()).spawn().unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    let info = loop {
        if let Ok(info) = DiscoveryInfo::read(dir.path()) {
            break info;
        }
        assert!(Instant::now() < deadline, "hostd never wrote hostd.json");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(info.pid, child.id());
    assert_eq!(info.protocol_version, PROTOCOL_VERSION);
    assert_eq!(info.token.len(), 64, "token is two hex UUIDs");
    TcpStream::connect(("127.0.0.1", info.port)).expect("hostd accepts TCP connections");

    let second = Command::new(EXE).env("PANEHOST_DATA_DIR", dir.path()).status().unwrap();
    assert!(second.success(), "a second instance exits cleanly");
    assert_eq!(DiscoveryInfo::read(dir.path()).unwrap(), info, "second instance must not overwrite discovery");

    child.kill().unwrap();
    let _ = child.wait();
    assert!(dir.path().join("logs").is_dir(), "logs directory created");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p panehost-hostd --test binary`
Expected: FAIL — "hostd never wrote hostd.json" (placeholder `main` exits immediately).

- [ ] **Step 3: Implement logging, instance guard, and main**

`crates/hostd/src/logging.rs`:
```rust
use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::EnvFilter;

/// Daily-rotated `hostd.YYYY-MM-DD.log`, 7 files kept. Keep the guard alive for the process lifetime.
pub fn init(dir: &Path) -> WorkerGuard {
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("hostd")
        .filename_suffix("log")
        .max_log_files(7)
        .build(dir)
        .expect("create log directory");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .with_env_filter(EnvFilter::try_from_env("PANEHOST_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    guard
}
```

`crates/hostd/src/instance.rs`:
```rust
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows_sys::Win32::System::Threading::CreateMutexW;

/// Holds the per-user named mutex for as long as it lives.
pub struct InstanceGuard(HANDLE);

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// `None` when another hostd already serves this data directory.
pub fn acquire(dir: &Path) -> Option<InstanceGuard> {
    let mut hasher = DefaultHasher::new();
    dir.to_string_lossy().to_lowercase().hash(&mut hasher);
    let name = format!("Local\\PanehostHostd-{:016x}", hasher.finish());
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return None;
    }
    Some(InstanceGuard(handle))
}
```

Update `crates/hostd/src/lib.rs` to:
```rust
//! panehost-hostd: owns terminal sessions so they outlive the UI.

pub mod coalesce;
mod connection;
pub mod instance;
pub mod logging;
pub mod registry;
pub mod ring;
pub mod server;
pub mod shell;
```

`crates/hostd/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use hostd::registry::{Registry, RegistryConfig};
use hostd::server::{ServerState, serve};
use panehost_protocol::{DiscoveryInfo, PROTOCOL_VERSION, data_dir};
use tokio::net::TcpListener;
use uuid::Uuid;

const RING_CAPACITY: usize = 4 << 20;

fn main() -> Result<()> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    let _log_guard = hostd::logging::init(&dir.join("logs"));
    let Some(_instance) = hostd::instance::acquire(&dir) else {
        tracing::info!("another hostd owns {}; exiting", dir.display());
        return Ok(());
    };
    tokio::runtime::Runtime::new()?.block_on(run(dir))
}

async fn run(dir: PathBuf) -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

    let registry = Registry::new(RegistryConfig {
        ring_capacity: RING_CAPACITY,
        env: vec![("PANEHOST_PORT".into(), port.to_string()), ("PANEHOST_TOKEN".into(), token.clone())],
    });
    DiscoveryInfo { port, token: token.clone(), pid: std::process::id(), protocol_version: PROTOCOL_VERSION }
        .write(&dir)?;
    tracing::info!(port, pid = std::process::id(), "hostd listening");

    serve(listener, Arc::new(ServerState { registry, token })).await?;
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p panehost-hostd --test binary`
Expected: PASS.

- [ ] **Step 5: Full crate check**

Run: `cargo test -p panehost-hostd && cargo clippy -p panehost-hostd --all-targets -- -D warnings`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/hostd
git commit -m "feat(hostd): binary with rolling logs, single-instance mutex, discovery file"
```

---

### Task 8: UI scaffold + protocol frames in TypeScript

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml` (repo root)
- Create: `ui/package.json`, `ui/tsconfig.json`, `ui/vite.config.ts`, `ui/index.html`
- Create: `ui/src/protocol/frames.ts`, `ui/src/protocol/frames.test.ts`, `ui/src/protocol/index.ts`
- Create: `ui/src/main.tsx` (temporary hello render, replaced in Task 11)

**Interfaces:**
- Consumes: generated types in `ui/src/protocol/generated/` (Task 1), `PROTOCOL_VERSION` in `version.ts`.
- Produces (`ui/src/protocol/index.ts`): re-exports all generated types; `PROTOCOL_VERSION`; `uuidToBytes(id: string): Uint8Array`, `bytesToUuid(b: Uint8Array): string`, `encodeFrame(paneId: string, data: Uint8Array): Uint8Array`, `decodeFrame(frame: ArrayBuffer): { paneId: string; data: Uint8Array } | null`.

- [ ] **Step 1: Create the package files**

Root `package.json`:
```json
{
  "name": "panehost",
  "private": true,
  "scripts": {
    "test": "cargo test --workspace && git diff --exit-code -- ui/src/protocol/generated && pnpm --dir ui test"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - ui
```

`ui/package.json`:
```json
{
  "name": "panehost-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Install dependencies (lets pnpm pick current versions and write them into `ui/package.json`):
```bash
cd ui
pnpm add react react-dom @xterm/xterm @xterm/addon-fit @xterm/addon-webgl @tauri-apps/api@^2 @fontsource-variable/inter @fontsource/jetbrains-mono
pnpm add -D vite @vitejs/plugin-react typescript vitest @types/react @types/react-dom
cd ..
```

`ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`ui/vite.config.ts`:
```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

`ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Panehost</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`ui/src/main.tsx` (temporary):
```tsx
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(<p>Panehost</p>);
```

- [ ] **Step 2: Write the failing test**

`ui/src/protocol/frames.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { bytesToUuid, decodeFrame, encodeFrame, uuidToBytes } from "./frames";

const ID = "0194d2b0-7c1e-7a3b-9f00-123456789abc";
// Same vector as crates/protocol/src/frame.rs.
const VECTOR_HEX = "0194d2b07c1e7a3b9f00123456789abc6869";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("frames", () => {
  it("encodes the shared cross-language vector", () => {
    expect(hex(encodeFrame(ID, new TextEncoder().encode("hi")))).toBe(VECTOR_HEX);
  });

  it("round-trips uuids", () => {
    expect(bytesToUuid(uuidToBytes(ID))).toBe(ID);
  });

  it("decodes what it encodes", () => {
    const frame = encodeFrame(ID, new Uint8Array([1, 2, 3]));
    const decoded = decodeFrame(frame.buffer as ArrayBuffer);
    expect(decoded?.paneId).toBe(ID);
    expect(Array.from(decoded!.data)).toEqual([1, 2, 3]);
  });

  it("rejects short frames", () => {
    expect(decodeFrame(new ArrayBuffer(15))).toBeNull();
  });

  it("rejects malformed ids", () => {
    expect(() => uuidToBytes("not-a-uuid")).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --dir ui test`
Expected: FAIL — cannot resolve `./frames`.

- [ ] **Step 4: Implement**

`ui/src/protocol/frames.ts`:
```ts
/** Binary frames carry terminal bytes: [16-byte pane UUID][payload]. Mirrors crates/protocol/src/frame.rs. */
const HEADER = 16;

export function uuidToBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`invalid pane id: ${id}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToUuid(bytes: Uint8Array): string {
  const h = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function encodeFrame(paneId: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + data.length);
  out.set(uuidToBytes(paneId), 0);
  out.set(data, HEADER);
  return out;
}

export function decodeFrame(frame: ArrayBuffer): { paneId: string; data: Uint8Array } | null {
  if (frame.byteLength < HEADER) return null;
  const bytes = new Uint8Array(frame);
  return { paneId: bytesToUuid(bytes.subarray(0, HEADER)), data: bytes.subarray(HEADER) };
}
```

`ui/src/protocol/index.ts`:
```ts
export type { ClientMsg } from "./generated/ClientMsg";
export type { PaneInfo } from "./generated/PaneInfo";
export type { PaneKind } from "./generated/PaneKind";
export type { PaneStatus } from "./generated/PaneStatus";
export type { ServerMsg } from "./generated/ServerMsg";
export type { ShellSpec } from "./generated/ShellSpec";
export type { SpawnRequest } from "./generated/SpawnRequest";
export { PROTOCOL_VERSION } from "./version";
export * from "./frames";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --dir ui test && pnpm --dir ui typecheck`
Expected: 5 tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml ui
git commit -m "feat(ui): Vite + React scaffold and binary frame codec"
```

---

### Task 9: UI pure logic — grid geometry, shortcuts, pane store

**Files:**
- Create: `ui/src/lib/grid.ts`, `ui/src/lib/grid.test.ts`
- Create: `ui/src/lib/shortcuts.ts`, `ui/src/lib/shortcuts.test.ts`
- Create: `ui/src/lib/panes.ts`, `ui/src/lib/panes.test.ts`

**Interfaces:**
- Consumes: `PaneInfo`, `ServerMsg` types (Task 8).
- Produces:
  - `computeGrid(count: number, width: number, height: number): { cols: number; rows: number }` — chooses the column count whose cell aspect ratio is closest (log distance) to `TARGET_CELL_RATIO = 1.6`; `rows = ceil(count / cols)`.
  - `gridPlacement(count: number, cols: number): { columns: number; spans: number[] }` — CSS-grid column count and per-pane `span` so an incomplete last row stretches to full width, with every pane in one flat grid (no remounts on layout change).
  - `matchShortcut(e: KeyLike): ShortcutAction | null` with `ShortcutAction = { type: "newPane" } | { type: "toggleZoom" } | { type: "focusIndex"; index: number }`.
  - `panesReducer(state: PanesState, msg: ServerMsg): PanesState`, `emptyPanes`, `PanesState = { order: string[]; byId: Record<string, PaneInfo> }`. Welcome replaces; Added/Updated upsert (idempotent); Removed deletes.

- [ ] **Step 1: Write the failing tests**

`ui/src/lib/grid.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeGrid, gridPlacement } from "./grid";

describe("computeGrid (1920x1080)", () => {
  const at = (n: number) => computeGrid(n, 1920, 1080);
  it("handles empty", () => expect(at(0)).toEqual({ cols: 0, rows: 0 }));
  it("1 pane fills", () => expect(at(1)).toEqual({ cols: 1, rows: 1 }));
  it("2 panes side by side", () => expect(at(2)).toEqual({ cols: 2, rows: 1 }));
  it("3 panes use 2x2 (last row stretches)", () => expect(at(3)).toEqual({ cols: 2, rows: 2 }));
  it("4 panes 2x2", () => expect(at(4)).toEqual({ cols: 2, rows: 2 }));
  it("6 panes 3x2", () => expect(at(6)).toEqual({ cols: 3, rows: 2 }));
  it("9 panes 3x3", () => expect(at(9)).toEqual({ cols: 3, rows: 3 }));
});

describe("computeGrid edge cases", () => {
  it("stacks on a portrait window", () => expect(computeGrid(2, 1080, 1920)).toEqual({ cols: 1, rows: 2 }));
  it("falls back to a square-ish grid before layout is measured", () =>
    expect(computeGrid(5, 0, 0)).toEqual({ cols: 3, rows: 2 }));
});

describe("gridPlacement", () => {
  it("full rows span one column", () => expect(gridPlacement(4, 2)).toEqual({ columns: 2, spans: [1, 1, 1, 1] }));
  it("stretches a lone last pane", () => expect(gridPlacement(3, 2)).toEqual({ columns: 2, spans: [1, 1, 2] }));
  it("stretches a partial last row", () =>
    expect(gridPlacement(5, 3)).toEqual({ columns: 6, spans: [2, 2, 2, 3, 3] }));
  it("single pane", () => expect(gridPlacement(1, 1)).toEqual({ columns: 1, spans: [1] }));
  it("empty", () => expect(gridPlacement(0, 0)).toEqual({ columns: 0, spans: [] }));
});
```

`ui/src/lib/shortcuts.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { type KeyLike, matchShortcut } from "./shortcuts";

const key = (over: Partial<KeyLike>): KeyLike => ({
  key: "",
  code: "",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

describe("matchShortcut", () => {
  it("Ctrl+Shift+T opens a new pane", () =>
    expect(matchShortcut(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }))).toEqual({ type: "newPane" }));
  it("Ctrl+Shift+Enter toggles zoom", () =>
    expect(matchShortcut(key({ key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true }))).toEqual({
      type: "toggleZoom",
    }));
  it("Alt+3 focuses the third pane", () =>
    expect(matchShortcut(key({ key: "3", code: "Digit3", altKey: true }))).toEqual({ type: "focusIndex", index: 2 }));
  it("passes plain Ctrl+T through to the terminal", () =>
    expect(matchShortcut(key({ key: "t", code: "KeyT", ctrlKey: true }))).toBeNull());
  it("passes Alt+0 through", () => expect(matchShortcut(key({ key: "0", code: "Digit0", altKey: true }))).toBeNull());
  it("passes Ctrl+C through", () => expect(matchShortcut(key({ key: "c", code: "KeyC", ctrlKey: true }))).toBeNull());
});
```

`ui/src/lib/panes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { PaneInfo } from "../protocol";
import { emptyPanes, panesReducer } from "./panes";

const pane = (id: string, title = id): PaneInfo => ({
  id,
  title,
  cwd: "C:\\",
  command: null,
  kind: "shell",
  shell: { kind: "powershell" },
  status: { state: "running" },
  cols: 120,
  rows: 32,
});

describe("panesReducer", () => {
  it("Welcome replaces all state", () => {
    const s1 = panesReducer(emptyPanes, { type: "PaneAdded", pane: pane("x") });
    const s2 = panesReducer(s1, { type: "Welcome", protocol_version: 1, panes: [pane("a"), pane("b")] });
    expect(s2.order).toEqual(["a", "b"]);
    expect(Object.keys(s2.byId).sort()).toEqual(["a", "b"]);
  });

  it("PaneAdded appends and is idempotent", () => {
    let s = panesReducer(emptyPanes, { type: "PaneAdded", pane: pane("a") });
    s = panesReducer(s, { type: "PaneAdded", pane: pane("a") });
    expect(s.order).toEqual(["a"]);
  });

  it("PaneUpdated replaces info in place", () => {
    let s = panesReducer(emptyPanes, { type: "Welcome", protocol_version: 1, panes: [pane("a"), pane("b")] });
    s = panesReducer(s, { type: "PaneUpdated", pane: { ...pane("a"), status: { state: "exited", code: 0 } } });
    expect(s.order).toEqual(["a", "b"]);
    expect(s.byId.a.status).toEqual({ state: "exited", code: 0 });
  });

  it("PaneRemoved deletes; unknown ids are no-ops", () => {
    let s = panesReducer(emptyPanes, { type: "Welcome", protocol_version: 1, panes: [pane("a"), pane("b")] });
    s = panesReducer(s, { type: "PaneRemoved", pane: "a" });
    expect(s.order).toEqual(["b"]);
    expect(s.byId.a).toBeUndefined();
    expect(panesReducer(s, { type: "PaneRemoved", pane: "zzz" })).toBe(s);
  });

  it("ignores unrelated messages", () => {
    expect(panesReducer(emptyPanes, { type: "Error", message: "x" })).toBe(emptyPanes);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir ui test`
Expected: FAIL — cannot resolve `./grid`, `./shortcuts`, `./panes`.

- [ ] **Step 3: Implement**

`ui/src/lib/grid.ts`:
```ts
/** Terminal cells read best slightly wider than tall. */
export const TARGET_CELL_RATIO = 1.6;

export interface GridShape {
  cols: number;
  rows: number;
}

export function computeGrid(count: number, width: number, height: number): GridShape {
  if (count <= 0) return { cols: 0, rows: 0 };
  if (width <= 0 || height <= 0) {
    const cols = Math.ceil(Math.sqrt(count));
    return { cols, rows: Math.ceil(count / cols) };
  }
  let best: GridShape = { cols: 1, rows: count };
  let bestScore = Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const ratio = width / cols / (height / rows);
    const score = Math.abs(Math.log(ratio / TARGET_CELL_RATIO));
    if (score < bestScore - 1e-9) {
      best = { cols, rows };
      bestScore = score;
    }
  }
  return best;
}

export interface GridPlacement {
  columns: number;
  spans: number[];
}

/**
 * One flat CSS grid for all panes (so panes never remount when the shape changes).
 * With r panes in an incomplete last row, the grid has cols*r columns: full-row
 * panes span r, last-row panes span cols, so the last row fills the width.
 */
export function gridPlacement(count: number, cols: number): GridPlacement {
  if (count <= 0 || cols <= 0) return { columns: 0, spans: [] };
  const remainder = count % cols;
  if (remainder === 0) return { columns: cols, spans: Array(count).fill(1) };
  const fullCount = count - remainder;
  return {
    columns: cols * remainder,
    spans: [...Array(fullCount).fill(remainder), ...Array(remainder).fill(cols)],
  };
}
```

`ui/src/lib/shortcuts.ts`:
```ts
export type ShortcutAction = { type: "newPane" } | { type: "toggleZoom" } | { type: "focusIndex"; index: number };

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** App shortcuts; everything else must reach the terminal untouched. */
export function matchShortcut(e: KeyLike): ShortcutAction | null {
  const { ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta } = e;
  if (meta) return null;
  if (ctrl && shift && !alt && e.code === "KeyT") return { type: "newPane" };
  if (ctrl && shift && !alt && e.key === "Enter") return { type: "toggleZoom" };
  if (alt && !ctrl && !shift && /^Digit[1-9]$/.test(e.code)) {
    return { type: "focusIndex", index: Number(e.code.slice(5)) - 1 };
  }
  return null;
}
```

`ui/src/lib/panes.ts`:
```ts
import type { PaneInfo, ServerMsg } from "../protocol";

export interface PanesState {
  order: string[];
  byId: Record<string, PaneInfo>;
}

export const emptyPanes: PanesState = { order: [], byId: {} };

export function panesReducer(state: PanesState, msg: ServerMsg): PanesState {
  switch (msg.type) {
    case "Welcome": {
      const byId: Record<string, PaneInfo> = {};
      for (const p of msg.panes) byId[p.id] = p;
      return { order: msg.panes.map((p) => p.id), byId };
    }
    case "PaneAdded":
    case "PaneUpdated": {
      const p = msg.pane;
      const known = p.id in state.byId;
      return { order: known ? state.order : [...state.order, p.id], byId: { ...state.byId, [p.id]: p } };
    }
    case "PaneRemoved": {
      if (!(msg.pane in state.byId)) return state;
      const { [msg.pane]: _removed, ...rest } = state.byId;
      return { order: state.order.filter((id) => id !== msg.pane), byId: rest };
    }
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --dir ui test && pnpm --dir ui typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib
git commit -m "feat(ui): grid geometry, shortcut matching, pane store reducer"
```

---

### Task 10: HostClient — connection, handshake, reconnect, output routing

**Files:**
- Create: `ui/src/lib/client.ts`, `ui/src/lib/client.test.ts`, `ui/src/lib/endpoint.ts`

**Interfaces:**
- Consumes: protocol types and frames (Task 8).
- Produces:
  - `interface Endpoint { port: number; token: string; protocol_version: number }`
  - `type ConnectionState = { kind: "connecting" } | { kind: "open" } | { kind: "closed"; retryInMs: number; message?: string } | { kind: "fatal"; message: string }`
  - `class HostClient(getEndpoint: () => Promise<Endpoint>, makeSocket?: (url: string) => WebSocket)` with `start()`, `stop()`, `send(msg: ClientMsg): boolean`, `sendInput(paneId: string, text: string): void`, `sendBytes(paneId: string, data: Uint8Array): void`, `onMessage(fn): () => void`, `onOutput(paneId, fn): () => void`, `onState(fn): () => void`.
  - `getEndpoint(): Promise<Endpoint>` in `endpoint.ts` — Tauri `invoke("get_endpoint")` inside the app; `?port=&token=` query params in a plain browser (dev/testing).

Behavior: calls `getEndpoint()` on **every** (re)connect — inside Tauri that re-runs `ensure_hostd`, which respawns a crashed hostd and picks up its new token. Backoff 250 ms doubling to 5 s, reset on `Welcome`. `VersionMismatch` → `fatal`, no retries.

- [ ] **Step 1: Write the failing test**

`ui/src/lib/client.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, type ServerMsg } from "../protocol";
import { type ConnectionState, HostClient } from "./client";

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = "blob";
  sent: unknown[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: ServerMsg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  receiveBinary(data: Uint8Array) {
    this.onmessage?.({ data: data.buffer });
  }
}

const ID = "0194d2b0-7c1e-7a3b-9f00-123456789abc";
const endpoint = { port: 4000, token: "tok", protocol_version: 1 };
const make = () => new HostClient(async () => endpoint, (url) => new FakeSocket(url) as unknown as WebSocket);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

describe("HostClient", () => {
  it("connects to the endpoint and sends Hello on open", async () => {
    const client = make();
    client.start();
    await flush();
    const ws = FakeSocket.all[0];
    expect(ws.url).toBe("ws://127.0.0.1:4000/ws");
    expect(ws.binaryType).toBe("arraybuffer");
    ws.open();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: "Hello", token: "tok", protocol_version: 1 });
  });

  it("reports open on Welcome and forwards messages", async () => {
    const client = make();
    const states: ConnectionState[] = [];
    const msgs: ServerMsg[] = [];
    client.onState((s) => states.push(s));
    client.onMessage((m) => msgs.push(m));
    client.start();
    await flush();
    FakeSocket.all[0].open();
    FakeSocket.all[0].receive({ type: "Welcome", protocol_version: 1, panes: [] });
    expect(states.at(-1)).toEqual({ kind: "open" });
    expect(msgs[0].type).toBe("Welcome");
  });

  it("routes binary output to the pane's listener", async () => {
    const client = make();
    const got: number[][] = [];
    client.onOutput(ID, (d) => got.push(Array.from(d)));
    client.start();
    await flush();
    FakeSocket.all[0].open();
    FakeSocket.all[0].receiveBinary(encodeFrame(ID, new Uint8Array([65, 66])));
    expect(got).toEqual([[65, 66]]);
  });

  it("encodes input as a binary frame", async () => {
    const client = make();
    client.start();
    await flush();
    const ws = FakeSocket.all[0];
    ws.open();
    client.sendInput(ID, "ls\r");
    const frame = ws.sent[1] as Uint8Array;
    expect(Array.from(frame.subarray(16))).toEqual([108, 115, 13]);
  });

  it("reconnects with backoff after the socket closes", async () => {
    const client = make();
    const states: ConnectionState[] = [];
    client.onState((s) => states.push(s));
    client.start();
    await flush();
    FakeSocket.all[0].close();
    expect(states.at(-1)).toEqual({ kind: "closed", retryInMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].close();
    expect(states.at(-1)).toEqual({ kind: "closed", retryInMs: 500 });
  });

  it("stops retrying on version mismatch", async () => {
    const client = make();
    const states: ConnectionState[] = [];
    client.onState((s) => states.push(s));
    client.start();
    await flush();
    FakeSocket.all[0].open();
    FakeSocket.all[0].receive({ type: "VersionMismatch", server_version: 2 });
    FakeSocket.all[0].close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(states.at(-1)?.kind).toBe("fatal");
  });

  it("retries when the endpoint lookup fails", async () => {
    let fail = true;
    const client = new HostClient(
      async () => {
        if (fail) throw new Error("hostd did not start");
        return endpoint;
      },
      (url) => new FakeSocket(url) as unknown as WebSocket,
    );
    const states: ConnectionState[] = [];
    client.onState((s) => states.push(s));
    client.start();
    await flush();
    expect(states.at(-1)).toEqual({ kind: "closed", retryInMs: 250, message: "hostd did not start" });
    fail = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir ui test`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 3: Implement**

`ui/src/lib/client.ts`:
```ts
import { type ClientMsg, decodeFrame, encodeFrame, PROTOCOL_VERSION, type ServerMsg } from "../protocol";

export interface Endpoint {
  port: number;
  token: string;
  protocol_version: number;
}

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "closed"; retryInMs: number; message?: string }
  | { kind: "fatal"; message: string };

const MIN_BACKOFF = 250;
const MAX_BACKOFF = 5000;

/** One WebSocket to hostd; survives hostd restarts by re-resolving the endpoint on every connect. */
export class HostClient {
  private ws: WebSocket | null = null;
  private open = false;
  private stopped = true;
  private backoff = MIN_BACKOFF;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly encoder = new TextEncoder();
  private readonly messageListeners = new Set<(msg: ServerMsg) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly outputListeners = new Map<string, (data: Uint8Array) => void>();

  constructor(
    private readonly getEndpoint: () => Promise<Endpoint>,
    private readonly makeSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    ws?.close();
  }

  send(msg: ClientMsg): boolean {
    if (!this.open || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendInput(paneId: string, text: string) {
    this.sendBytes(paneId, this.encoder.encode(text));
  }

  sendBytes(paneId: string, data: Uint8Array) {
    if (this.open && this.ws) this.ws.send(encodeFrame(paneId, data));
  }

  onMessage(fn: (msg: ServerMsg) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onState(fn: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** One listener per pane (the pane's terminal). */
  onOutput(paneId: string, fn: (data: Uint8Array) => void): () => void {
    this.outputListeners.set(paneId, fn);
    return () => {
      if (this.outputListeners.get(paneId) === fn) this.outputListeners.delete(paneId);
    };
  }

  private setState(state: ConnectionState) {
    this.stateListeners.forEach((fn) => fn(state));
  }

  private async connect() {
    if (this.stopped) return;
    this.setState({ kind: "connecting" });
    let endpoint: Endpoint;
    try {
      endpoint = await this.getEndpoint();
    } catch (e) {
      this.scheduleRetry(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.stopped) return;

    const ws = this.makeSocket(`ws://127.0.0.1:${endpoint.port}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.open = true;
      this.send({ type: "Hello", token: endpoint.token, protocol_version: PROTOCOL_VERSION });
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as ServerMsg;
        if (msg.type === "Welcome") {
          this.backoff = MIN_BACKOFF;
          this.setState({ kind: "open" });
        } else if (msg.type === "VersionMismatch") {
          this.stopped = true;
          this.setState({
            kind: "fatal",
            message: `The background service speaks protocol v${msg.server_version}; this window expects v${PROTOCOL_VERSION}. Restart the service to update.`,
          });
        }
        this.messageListeners.forEach((fn) => fn(msg));
        return;
      }
      const frame = decodeFrame(ev.data as ArrayBuffer);
      if (frame) this.outputListeners.get(frame.paneId)?.(frame.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.open = false;
      this.scheduleRetry();
    };
  }

  private scheduleRetry(message?: string) {
    if (this.stopped) return;
    const retryInMs = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    this.setState(message ? { kind: "closed", retryInMs, message } : { kind: "closed", retryInMs });
    this.timer = setTimeout(() => void this.connect(), retryInMs);
  }
}
```

`ui/src/lib/endpoint.ts`:
```ts
import { PROTOCOL_VERSION } from "../protocol";
import type { Endpoint } from "./client";

/**
 * Inside Tauri: asks the app, which finds or launches hostd.
 * In a plain browser (dev): reads ?port=&token= copied from %APPDATA%\Panehost\hostd.json.
 */
export async function getEndpoint(): Promise<Endpoint> {
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Endpoint>("get_endpoint");
  }
  const params = new URLSearchParams(window.location.search);
  const port = Number(params.get("port"));
  const token = params.get("token");
  if (!port || !token) {
    throw new Error("Open with ?port=<port>&token=<token> from %APPDATA%\\Panehost\\hostd.json, or run the Tauri app.");
  }
  return { port, token, protocol_version: PROTOCOL_VERSION };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --dir ui test && pnpm --dir ui typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib
git commit -m "feat(ui): HostClient with handshake, backoff reconnect, output routing"
```

---

### Task 11: Terminal grid UI

**Files:**
- Create: `ui/src/lib/terminals.ts`, `ui/src/lib/useElementSize.ts`
- Create: `ui/src/components/TerminalView.tsx`, `ui/src/components/Pane.tsx`, `ui/src/components/StatusBar.tsx`, `ui/src/components/NewPaneDialog.tsx`
- Create: `ui/src/App.tsx`, `ui/src/styles.css`
- Modify: `ui/src/main.tsx` (replace temporary render)

**Interfaces:**
- Consumes: `HostClient`, `ConnectionState` (Task 10), `getEndpoint` (Task 10), `computeGrid`, `gridPlacement`, `matchShortcut`, `panesReducer` (Task 9), protocol types (Task 8).
- Produces: the full Plan 1 UI. `terminals.ts` exports `getTerminal(paneId, client): CachedTerminal`, `openIfNeeded(entry)`, `focusTerminal(paneId)`, `pruneTerminals(live: Set<string>)`, with `CachedTerminal = { term, fit, element, opened, attachedEpoch, lastSize, dispose }`.

Key rules:
- One xterm `Terminal` per pane, created once, living in a detached `<div>` that is re-parented on mount — never recreated on layout changes.
- Attach once per connection **epoch** (incremented on every `Welcome`) per pane — remounts don't re-attach; reconnects do.
- Resize is debounced 50 ms and sent only when cols/rows change.
- App shortcuts are caught in a window-level **capture** keydown listener so xterm never sees them; everything else reaches the terminal.
- No StrictMode (it would double-create terminals in dev).

This task's verification is interactive (xterm needs a real browser); pure logic it depends on is already unit-tested.

- [ ] **Step 1: Terminal cache and size hook**

`ui/src/lib/terminals.ts`:
```ts
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { HostClient } from "./client";

const THEME = {
  background: "#11151b",
  foreground: "#d7dce4",
  cursor: "#5b8cff",
  cursorAccent: "#11151b",
  selectionBackground: "#5b8cff44",
  black: "#1b212a",
  red: "#f0524f",
  green: "#3fb950",
  yellow: "#f5a524",
  blue: "#5b8cff",
  magenta: "#c678dd",
  cyan: "#39c5cf",
  white: "#d7dce4",
  brightBlack: "#6b7280",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#ffc24b",
  brightBlue: "#79a6ff",
  brightMagenta: "#d8a0ec",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

export interface CachedTerminal {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  opened: boolean;
  /** Connection epoch this pane was last attached in (0 = never). */
  attachedEpoch: number;
  lastSize: { cols: number; rows: number };
  dispose: () => void;
}

const cache = new Map<string, CachedTerminal>();

export function getTerminal(paneId: string, client: HostClient): CachedTerminal {
  const existing = cache.get(paneId);
  if (existing) return existing;

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 10_000,
    cursorBlink: true,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const element = document.createElement("div");
  element.className = "terminal-host";

  const offOutput = client.onOutput(paneId, (data) => term.write(data));
  const onData = term.onData((text) => client.sendInput(paneId, text));
  const onBinary = term.onBinary((bin) =>
    client.sendBytes(paneId, Uint8Array.from(bin, (c) => c.charCodeAt(0))),
  );

  const entry: CachedTerminal = {
    term,
    fit,
    element,
    opened: false,
    attachedEpoch: 0,
    lastSize: { cols: 0, rows: 0 },
    dispose: () => {
      offOutput();
      onData.dispose();
      onBinary.dispose();
      term.dispose();
      cache.delete(paneId);
    },
  };
  cache.set(paneId, entry);
  return entry;
}

/** Call after `entry.element` is in the DOM so xterm can measure the font. */
export function openIfNeeded(entry: CachedTerminal) {
  if (entry.opened) return;
  entry.term.open(entry.element);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    entry.term.loadAddon(webgl);
  } catch {
    // WebGL unavailable: xterm keeps its DOM renderer.
  }
  entry.opened = true;
}

export function focusTerminal(paneId: string) {
  cache.get(paneId)?.term.focus();
}

export function pruneTerminals(live: Set<string>) {
  for (const [id, entry] of cache) if (!live.has(id)) entry.dispose();
}
```

`ui/src/lib/useElementSize.ts`:
```ts
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
```

- [ ] **Step 2: Components**

`ui/src/components/TerminalView.tsx`:
```tsx
import { useEffect, useRef } from "react";
import type { HostClient } from "../lib/client";
import { getTerminal, openIfNeeded } from "../lib/terminals";

interface Props {
  paneId: string;
  client: HostClient;
  /** Increments on every Welcome; 0 = not connected yet. */
  epoch: number;
  onFocus: () => void;
}

const RESIZE_DEBOUNCE_MS = 50;

export function TerminalView({ paneId, client, epoch, onFocus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Mount: re-parent the cached terminal, keep it fitted, report focus.
  useEffect(() => {
    const container = containerRef.current!;
    const entry = getTerminal(paneId, client);
    container.appendChild(entry.element);
    openIfNeeded(entry);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const refit = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      entry.fit.fit();
      const { cols, rows } = entry.term;
      if (cols === entry.lastSize.cols && rows === entry.lastSize.rows) return;
      entry.lastSize = { cols, rows };
      if (entry.attachedEpoch > 0) client.send({ type: "Resize", pane: paneId, cols, rows });
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(refit, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    const textarea = entry.term.textarea;
    textarea?.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      textarea?.removeEventListener("focus", onFocus);
      entry.element.remove();
    };
  }, [paneId, client, onFocus]);

  // Attach once per connection epoch; replay arrives as reset + history.
  useEffect(() => {
    if (epoch === 0) return;
    const entry = getTerminal(paneId, client);
    if (entry.attachedEpoch === epoch) return;
    if (containerRef.current && containerRef.current.clientWidth > 0) entry.fit.fit();
    const { cols, rows } = entry.term;
    entry.lastSize = { cols, rows };
    if (client.send({ type: "Attach", pane: paneId, cols, rows })) entry.attachedEpoch = epoch;
  }, [epoch, paneId, client]);

  return <div ref={containerRef} className="terminal-container" />;
}
```

`ui/src/components/Pane.tsx`:
```tsx
import { useCallback, useEffect, useState } from "react";
import type { HostClient } from "../lib/client";
import type { PaneInfo, ShellSpec } from "../protocol";
import { TerminalView } from "./TerminalView";

interface Props {
  info: PaneInfo;
  client: HostClient;
  epoch: number;
  index: number;
  span: number;
  focused: boolean;
  zoomed: boolean;
  onFocus: (id: string) => void;
  onToggleZoom: (id: string) => void;
}

const ARM_TIMEOUT_MS = 3000;

function shellName(shell: ShellSpec): string {
  return shell.kind === "wsl" ? (shell.distro ? `wsl:${shell.distro}` : "wsl") : shell.kind;
}

function statusText(info: PaneInfo): string {
  switch (info.status.state) {
    case "running":
      return "running";
    case "exited":
      return `exited ${info.status.code}`;
    case "error":
      return "failed to start";
  }
}

export function Pane({ info, client, epoch, index, span, focused, zoomed, onFocus, onToggleZoom }: Props) {
  const [armed, setArmed] = useState(false);
  const running = info.status.state === "running";
  const focus = useCallback(() => onFocus(info.id), [onFocus, info.id]);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const close = () => {
    if (!running) {
      client.send({ type: "Remove", pane: info.id });
    } else if (!armed) {
      setArmed(true);
    } else {
      client.send({ type: "Kill", pane: info.id });
      setArmed(false);
    }
  };

  const classes = ["pane", `status-${info.status.state}`, focused && "focused", zoomed && "zoomed"]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classes} style={{ gridColumn: `span ${span}` }} onMouseDown={focus}>
      <header className="pane-header">
        <span className="dot" aria-hidden="true" />
        <span className="pane-index">{index + 1}</span>
        <span className="pane-title">{info.title}</span>
        <span className="pane-meta">
          {info.kind === "claude" ? "claude" : shellName(info.shell)}
          {info.command ? ` · ${info.command}` : ""}
        </span>
        <span className="pane-status">{statusText(info)}</span>
        <button
          className="icon-button"
          title={zoomed ? "Restore grid (Ctrl+Shift+Enter)" : "Zoom (Ctrl+Shift+Enter)"}
          onClick={() => onToggleZoom(info.id)}
        >
          {zoomed ? "⤡" : "⤢"}
        </button>
        <button
          className={armed ? "icon-button danger armed" : "icon-button danger"}
          title={running ? (armed ? "Click again to kill" : "Kill process") : "Remove pane"}
          onClick={close}
        >
          {armed ? "Kill?" : "✕"}
        </button>
      </header>
      {info.status.state === "error" ? (
        <div className="pane-error">
          <strong>Could not start this pane.</strong>
          <p>{info.status.message}</p>
        </div>
      ) : (
        <TerminalView paneId={info.id} client={client} epoch={epoch} onFocus={focus} />
      )}
    </section>
  );
}
```

`ui/src/components/StatusBar.tsx`:
```tsx
import type { ConnectionState } from "../lib/client";

interface Props {
  paneCount: number;
  runningCount: number;
  connection: ConnectionState;
  onNewPane: () => void;
}

function connectionLabel(c: ConnectionState): string | null {
  switch (c.kind) {
    case "open":
      return null;
    case "connecting":
      return "Connecting…";
    case "closed":
      return `Reconnecting in ${Math.ceil(c.retryInMs / 1000)}s`;
    case "fatal":
      return "Service update required";
  }
}

export function StatusBar({ paneCount, runningCount, connection, onNewPane }: Props) {
  const label = connectionLabel(connection);
  return (
    <header className="status-bar">
      <span className="brand">Panehost</span>
      <span className="status-summary">
        {paneCount} {paneCount === 1 ? "pane" : "panes"} · {runningCount} running
      </span>
      <span className="spacer" />
      {label && <span className={`connection connection-${connection.kind}`}>{label}</span>}
      <button className="button" onClick={onNewPane} title="New pane (Ctrl+Shift+T)">
        + New pane
      </button>
    </header>
  );
}
```

`ui/src/components/NewPaneDialog.tsx`:
```tsx
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { PaneKind, ShellSpec, SpawnRequest } from "../protocol";

interface Props {
  open: boolean;
  onClose: () => void;
  onSpawn: (request: SpawnRequest) => void;
}

type ShellChoice = "powershell" | "cmd" | "wsl";
const LAST_CWD_KEY = "panehost.lastCwd";

function loadLastCwd(): string {
  try {
    return localStorage.getItem(LAST_CWD_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCwd(cwd: string) {
  try {
    localStorage.setItem(LAST_CWD_KEY, cwd);
  } catch {
    // Storage unavailable; the default (profile dir) still works.
  }
}

export function NewPaneDialog({ open, onClose, onSpawn }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<PaneKind>("claude");
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState(loadLastCwd);
  const [command, setCommand] = useState("");
  const [shell, setShell] = useState<ShellChoice>("powershell");
  const [distro, setDistro] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const spec: ShellSpec = shell === "wsl" ? { kind: "wsl", distro: distro.trim() || null } : { kind: shell };
    onSpawn({
      title: title.trim() || (kind === "claude" ? "claude" : shell),
      cwd: cwd.trim(),
      command: command.trim() || null,
      kind,
      shell: spec,
    });
    saveLastCwd(cwd.trim());
    setTitle("");
    setCommand("");
    onClose();
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose}>
      <form onSubmit={submit}>
        <h2>New pane</h2>
        <fieldset className="segmented">
          <legend>Type</legend>
          <label>
            <input type="radio" checked={kind === "claude"} onChange={() => setKind("claude")} /> Claude Code
          </label>
          <label>
            <input type="radio" checked={kind === "shell"} onChange={() => setKind("shell")} /> Shell
          </label>
        </fieldset>
        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "claude" ? "claude" : shell} autoFocus />
        </label>
        <label className="field">
          <span>Working directory</span>
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Your profile folder" spellCheck={false} />
        </label>
        <label className="field">
          <span>Command</span>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={kind === "claude" ? "claude" : "Interactive shell"}
            spellCheck={false}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Shell</span>
            <select value={shell} onChange={(e) => setShell(e.target.value as ShellChoice)}>
              <option value="powershell">PowerShell</option>
              <option value="cmd">Command Prompt</option>
              <option value="wsl">WSL</option>
            </select>
          </label>
          {shell === "wsl" && (
            <label className="field">
              <span>Distro</span>
              <input value={distro} onChange={(e) => setDistro(e.target.value)} placeholder="Default" />
            </label>
          )}
        </div>
        <footer className="dialog-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Start
          </button>
        </footer>
      </form>
    </dialog>
  );
}
```

- [ ] **Step 3: App, entry point, styles**

`ui/src/App.tsx`:
```tsx
import { useCallback, useEffect, useReducer, useState } from "react";
import { NewPaneDialog } from "./components/NewPaneDialog";
import { Pane } from "./components/Pane";
import { StatusBar } from "./components/StatusBar";
import type { ConnectionState, HostClient } from "./lib/client";
import { computeGrid, gridPlacement } from "./lib/grid";
import { emptyPanes, panesReducer } from "./lib/panes";
import { matchShortcut } from "./lib/shortcuts";
import { focusTerminal, pruneTerminals } from "./lib/terminals";
import { useElementSize } from "./lib/useElementSize";

const ERROR_DISMISS_MS = 6000;

export function App({ client }: { client: HostClient }) {
  const [panes, dispatch] = useReducer(panesReducer, emptyPanes);
  const [connection, setConnection] = useState<ConnectionState>({ kind: "connecting" });
  const [epoch, setEpoch] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gridRef, size] = useElementSize<HTMLElement>();

  useEffect(() => {
    const offMessage = client.onMessage((msg) => {
      dispatch(msg);
      if (msg.type === "Welcome") setEpoch((e) => e + 1);
      if (msg.type === "Error") setError(msg.message);
    });
    const offState = client.onState(setConnection);
    client.start();
    return () => {
      offMessage();
      offState();
      client.stop();
    };
  }, [client]);

  useEffect(() => {
    const live = new Set(panes.order);
    pruneTerminals(live);
    if (zoomedId && !live.has(zoomedId)) setZoomedId(null);
    if (focusedId && !live.has(focusedId)) setFocusedId(null);
  }, [panes.order, zoomedId, focusedId]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), ERROR_DISMISS_MS);
    return () => clearTimeout(t);
  }, [error]);

  const toggleZoom = useCallback((id: string) => setZoomedId((z) => (z === id ? null : id)), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = matchShortcut(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.type === "newPane") setDialogOpen(true);
      if (action.type === "toggleZoom" && focusedId) toggleZoom(focusedId);
      if (action.type === "focusIndex") {
        const id = panes.order[action.index];
        if (id) {
          setFocusedId(id);
          focusTerminal(id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [focusedId, panes.order, toggleZoom]);

  const count = panes.order.length;
  const shape = computeGrid(count, size.width, size.height);
  const placement = gridPlacement(count, shape.cols);
  const runningCount = panes.order.filter((id) => panes.byId[id].status.state === "running").length;

  return (
    <div className="app">
      <StatusBar
        paneCount={count}
        runningCount={runningCount}
        connection={connection}
        onNewPane={() => setDialogOpen(true)}
      />
      {connection.kind === "fatal" && <div className="banner banner-error">{connection.message}</div>}
      {connection.kind === "closed" && (
        <div className="banner">
          Background service disconnected — retrying in {Math.ceil(connection.retryInMs / 1000)}s
          {connection.message ? `: ${connection.message}` : ""}
        </div>
      )}
      {error && (
        <div className="banner banner-error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <main
        ref={gridRef}
        className="grid"
        style={
          count > 0
            ? {
                gridTemplateColumns: `repeat(${placement.columns}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${shape.rows}, minmax(0, 1fr))`,
              }
            : undefined
        }
      >
        {count === 0 && (
          <div className="empty-state">
            <p>No panes yet.</p>
            <button className="button primary" onClick={() => setDialogOpen(true)}>
              Start a pane
            </button>
            <p className="hint">Ctrl+Shift+T</p>
          </div>
        )}
        {panes.order.map((id, i) => (
          <Pane
            key={id}
            info={panes.byId[id]}
            client={client}
            epoch={epoch}
            index={i}
            span={placement.spans[i]}
            focused={focusedId === id}
            zoomed={zoomedId === id}
            onFocus={setFocusedId}
            onToggleZoom={toggleZoom}
          />
        ))}
      </main>
      <NewPaneDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSpawn={(request) => client.send({ type: "Spawn", request })}
      />
    </div>
  );
}
```

`ui/src/main.tsx`:
```tsx
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { HostClient } from "./lib/client";
import { getEndpoint } from "./lib/endpoint";

// xterm measures glyphs when a terminal opens; load the font first.
await Promise.all([
  document.fonts.load("13px 'JetBrains Mono'"),
  document.fonts.load("bold 13px 'JetBrains Mono'"),
]);

const client = new HostClient(getEndpoint);
createRoot(document.getElementById("root")!).render(<App client={client} />);
```

`ui/src/styles.css`:
```css
:root {
  --bg: #0e1116;
  --surface: #11151b;
  --surface-2: #171c24;
  --surface-3: #1e2530;
  --border: #242b36;
  --border-strong: #323b49;
  --text: #e6e9ef;
  --text-dim: #8b94a3;
  --text-faint: #5d6675;
  --accent: #5b8cff;
  --st-working: #5b8cff;
  --st-waiting: #f5a524;
  --st-done: #3fb950;
  --st-error: #f0524f;
  --st-idle: #6b7280;
  --font-ui: "Inter Variable", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", Consolas, monospace;
  --radius: 8px;
  --gap: 6px;
  --motion: 150ms;
  color-scheme: dark;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --motion: 0ms;
  }
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  font: 13px/1.4 var(--font-ui);
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* Status bar */
.status-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex: none;
}
.brand {
  font-weight: 650;
  letter-spacing: 0.01em;
}
.status-summary {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.spacer {
  flex: 1;
}
.connection {
  color: var(--st-waiting);
  font-size: 12px;
}
.connection-fatal {
  color: var(--st-error);
}

/* Buttons */
.button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface-3);
  color: var(--text);
  font: inherit;
  cursor: pointer;
  transition: background var(--motion), border-color var(--motion);
}
.button:hover {
  border-color: var(--text-faint);
}
.button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.button.ghost {
  background: transparent;
}
.button:focus-visible,
.icon-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.icon-button {
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  cursor: pointer;
}
.icon-button:hover {
  background: var(--surface-3);
  color: var(--text);
}
.icon-button.danger:hover,
.icon-button.armed {
  color: var(--st-error);
}

/* Banners */
.banner {
  padding: 8px 12px;
  background: color-mix(in srgb, var(--st-waiting) 14%, var(--surface-2));
  border-bottom: 1px solid var(--border);
  color: var(--text);
  flex: none;
}
.banner-error {
  background: color-mix(in srgb, var(--st-error) 16%, var(--surface-2));
  cursor: pointer;
}

/* Grid */
.grid {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  gap: var(--gap);
  padding: var(--gap);
}
.empty-state {
  grid-column: 1 / -1;
  place-self: center;
  text-align: center;
  color: var(--text-dim);
}
.hint {
  color: var(--text-faint);
  font-size: 12px;
}

/* Pane */
.pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
  transition: border-color var(--motion);
}
.pane.focused {
  border-color: var(--border-strong);
}
.pane.zoomed {
  position: absolute;
  inset: var(--gap);
  z-index: 2;
}
.pane-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex: none;
  user-select: none;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--st-idle);
  flex: none;
}
.status-exited .dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--st-idle);
}
.status-error .dot {
  background: var(--st-error);
}
.pane-index {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.pane-title {
  font-weight: 600;
  white-space: nowrap;
}
.pane-meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.pane-status {
  color: var(--text-faint);
  font-size: 11.5px;
  white-space: nowrap;
}
.status-error .pane-status {
  color: var(--st-error);
}
.pane-error {
  padding: 16px;
  color: var(--text-dim);
}
.pane-error p {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--st-error);
}

/* Terminal */
.terminal-container {
  flex: 1;
  min-height: 0;
  padding: 4px 0 0 8px;
  background: var(--surface);
}
.terminal-host {
  width: 100%;
  height: 100%;
}

/* Dialog */
.dialog {
  width: min(480px, calc(100vw - 32px));
  padding: 20px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--text);
}
.dialog::backdrop {
  background: rgb(0 0 0 / 0.5);
}
.dialog h2 {
  margin: 0 0 16px;
  font-size: 15px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  flex: 1;
}
.field span {
  color: var(--text-dim);
  font-size: 12px;
}
.field input,
.field select {
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
.field input:focus,
.field select:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
.field-row {
  display: flex;
  gap: 12px;
}
.segmented {
  display: flex;
  gap: 16px;
  margin: 0 0 12px;
  padding: 0;
  border: 0;
}
.segmented legend {
  margin-bottom: 6px;
  color: var(--text-dim);
  font-size: 12px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
```

- [ ] **Step 4: Typecheck, unit tests, and production build**

Run: `pnpm --dir ui typecheck && pnpm --dir ui test && pnpm --dir ui build`
Expected: clean typecheck, all tests PASS, `ui/dist/` produced.

- [ ] **Step 5: Verify in a browser against a real hostd**

```powershell
cargo build -p panehost-hostd
Start-Process target\debug\panehost-hostd.exe
Get-Content $env:APPDATA\Panehost\hostd.json   # note port + token
pnpm --dir ui dev
```
Open `http://localhost:5173/?port=<port>&token=<token>` and check each item:
1. Empty state shows; **+ New pane** opens the dialog.
2. Start a **Shell / PowerShell** pane with blank cwd → prompt appears in your profile folder; typing works; `Get-ChildItem` output renders with colors.
3. Start 3 more panes → grid goes 1 → 2×1 → 2×2 (3 panes: last pane stretches full width).
4. Resize the browser window → terminals refit; `$Host.UI.RawUI.WindowSize` in PowerShell reflects the new size.
5. `Ctrl+Shift+Enter` zooms the focused pane and restores it; `Alt+2` focuses pane 2; `Ctrl+C` still interrupts a running `ping -t localhost`.
6. **Reload the page** → every pane reappears with its scrollback; still interactive.
7. In a pane run `ping -n 30 localhost`, close the tab, reopen the same URL 10 s later → the ping output that arrived while the tab was closed is there, and it is still counting.
8. Start a pane with cwd `C:\nope` → pane shows "Could not start this pane" with the message.
9. ✕ on a running pane → turns into **Kill?**; second click kills → status "exited 1"; ✕ again removes it.
10. `Stop-Process -Name panehost-hostd` → the banner "Background service disconnected — retrying in Ns" appears and the countdown backs off (1s, 1s, 2s, 3s, 5s). In a plain browser the URL's token is fixed, so it will not reconnect to a new hostd — that is expected; the Tauri path re-resolves the endpoint and is verified in Task 12/13.

Stop hostd afterwards: `Stop-Process -Name panehost-hostd`.

- [ ] **Step 6: Commit**

```bash
git add ui
git commit -m "feat(ui): auto-tiling terminal grid with zoom, focus, new-pane dialog"
```

---

### Task 12: Tauri app shell — discover or launch hostd

**Files:**
- Create: `crates/app/Cargo.toml`, `crates/app/build.rs`, `crates/app/tauri.conf.json`, `crates/app/capabilities/default.json`
- Create: `crates/app/src/main.rs`, `crates/app/src/hostd_launcher.rs`
- Create: `scripts/make_icon.py`; generated `crates/app/icons/*`
- Modify: root `package.json` (add `@tauri-apps/cli`, `dev`/`build` scripts)

**Interfaces:**
- Consumes: `DiscoveryInfo`, `data_dir`, `PROTOCOL_VERSION` (Task 2). The UI calls `invoke("get_endpoint")` (Task 10).
- Produces: `panehost.exe`. Tauri command `get_endpoint() -> Result<Endpoint, String>` where `Endpoint { port: u16, token: String, protocol_version: u32 }` (snake_case JSON). `hostd_launcher::ensure_hostd(dir: &Path) -> anyhow::Result<Endpoint>`: reuses a live hostd (discovery file + TCP connect within 300 ms), else spawns `panehost-hostd.exe` from the same folder as `panehost.exe`, detached, and waits ≤3 s for a new live discovery.

- [ ] **Step 1: Write the failing launcher test**

`crates/app/Cargo.toml`:
```toml
[package]
name = "panehost"
version.workspace = true
edition.workspace = true

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
panehost-protocol = { path = "../protocol" }
tauri = { version = "2", features = [] }
tauri-plugin-single-instance = "2"
serde.workspace = true
serde_json.workspace = true
anyhow.workspace = true

[dev-dependencies]
tempfile.workspace = true
```

`crates/app/src/hostd_launcher.rs` (tests first; implementation in Step 3):
```rust
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use panehost_protocol::DiscoveryInfo;
use serde::Serialize;

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn live_hostd_requires_a_listening_port() {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let info = DiscoveryInfo { port, token: "t".into(), pid: 1, protocol_version: 1 };
        info.write(dir.path()).unwrap();
        assert_eq!(live_hostd(dir.path()), Some(info));

        drop(listener);
        assert_eq!(live_hostd(dir.path()), None, "stale discovery must not count as live");
    }

    #[test]
    fn live_hostd_is_none_without_discovery() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(live_hostd(dir.path()), None);
    }

    #[test]
    fn endpoint_serializes_snake_case() {
        let json = serde_json::to_value(Endpoint { port: 1, token: "t".into(), protocol_version: 1 }).unwrap();
        assert_eq!(json, serde_json::json!({"port": 1, "token": "t", "protocol_version": 1}));
    }
}
```

`crates/app/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 2: Create icons, Tauri config, capability, and a stub main so the crate builds**

`scripts/make_icon.py`:
```python
"""Writes crates/app/icons/source.png: a rounded tile holding a 2x2 pane grid (one pane amber)."""
import pathlib
import struct
import zlib

SIZE = 1024
BG = (14, 17, 22, 255)
ACCENT = (91, 140, 255, 255)
AMBER = (245, 165, 36, 255)
TILES = [
    (232, 232, 492, 492, ACCENT),
    (532, 232, 792, 492, ACCENT),
    (232, 532, 492, 792, ACCENT),
    (532, 532, 792, 792, AMBER),
]


def inside(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixel(x, y):
    if not inside(x, y, 64, 64, 960, 960, 200):
        return (0, 0, 0, 0)
    for x0, y0, x1, y1, color in TILES:
        if inside(x, y, x0, y0, x1, y1, 56):
            return color
    return BG


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


rows = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(SIZE)) for y in range(SIZE))
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(rows, 9))
    + chunk(b"IEND", b"")
)
out = pathlib.Path(__file__).resolve().parent.parent / "crates" / "app" / "icons" / "source.png"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(png)
print(f"wrote {out}")
```

Install the Tauri CLI at the workspace root and generate the icons:
```bash
pnpm add -Dw @tauri-apps/cli@^2
python scripts/make_icon.py
pnpm tauri icon crates/app/icons/source.png -o crates/app/icons
```
Expected: `crates/app/icons/` contains `icon.ico`, `32x32.png`, `128x128.png`, `128x128@2x.png` (plus other sizes).

Root `package.json` becomes:
```json
{
  "name": "panehost",
  "private": true,
  "scripts": {
    "dev": "cargo build -p panehost-hostd && tauri dev",
    "build": "cargo build --release -p panehost-hostd && tauri build --no-bundle",
    "test": "cargo test --workspace && git diff --exit-code -- ui/src/protocol/generated && pnpm --dir ui test"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.11.5"
  }
}
```
(keep whatever exact `@tauri-apps/cli` version pnpm wrote.)

`crates/app/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Panehost",
  "version": "0.1.0",
  "identifier": "dev.panehost.app",
  "build": {
    "devUrl": "http://localhost:5173",
    "frontendDist": "../../ui/dist",
    "beforeDevCommand": "pnpm --dir ui dev",
    "beforeBuildCommand": "pnpm --dir ui build"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Panehost",
        "width": 1600,
        "height": 960,
        "minWidth": 800,
        "minHeight": 500,
        "backgroundColor": "#0e1116"
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
    }
  },
  "bundle": {
    "active": false,
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.ico"]
  }
}
```

`crates/app/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Main window",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

`crates/app/src/main.rs` (stub for now):
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hostd_launcher;

fn main() {}
```

Run: `cargo test -p panehost`
Expected: compile errors — `live_hostd`, `Endpoint` not found.

- [ ] **Step 3: Implement the launcher**

Add above the test module in `crates/app/src/hostd_launcher.rs`:
```rust
const HOSTD_EXE: &str = "panehost-hostd.exe";
const START_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// What the UI needs to open its WebSocket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub protocol_version: u32,
}

impl From<DiscoveryInfo> for Endpoint {
    fn from(info: DiscoveryInfo) -> Self {
        Self { port: info.port, token: info.token, protocol_version: info.protocol_version }
    }
}

/// Reuses the running hostd or starts one. Called on every UI (re)connect,
/// so a crashed hostd is respawned transparently.
pub fn ensure_hostd(dir: &Path) -> Result<Endpoint> {
    if let Some(info) = live_hostd(dir) {
        return Ok(info.into());
    }
    let stale_pid = DiscoveryInfo::read(dir).ok().map(|i| i.pid);
    let exe = hostd_exe()?;
    Command::new(&exe)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to launch {}", exe.display()))?;

    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(info) = live_hostd(dir).filter(|i| Some(i.pid) != stale_pid) {
            return Ok(info.into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    bail!("the background service did not start within 3 s — see logs in {}", dir.join("logs").display())
}

/// Discovery info whose port currently accepts connections.
fn live_hostd(dir: &Path) -> Option<DiscoveryInfo> {
    let info = DiscoveryInfo::read(dir).ok()?;
    let addr = SocketAddr::from(([127, 0, 0, 1], info.port));
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    Some(info)
}

fn hostd_exe() -> Result<PathBuf> {
    let exe = std::env::current_exe()?.with_file_name(HOSTD_EXE);
    if !exe.exists() {
        bail!("{} not found — build it with `cargo build -p panehost-hostd`", exe.display());
    }
    Ok(exe)
}
```
Add `use std::os::windows::process::CommandExt;` to the imports at the top of the file.

- [ ] **Step 4: Run launcher tests**

Run: `cargo test -p panehost`
Expected: 3 tests PASS.

- [ ] **Step 5: Wire the Tauri entry point**

`crates/app/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hostd_launcher;

use hostd_launcher::{Endpoint, ensure_hostd};
use tauri::Manager;

#[tauri::command]
async fn get_endpoint() -> Result<Endpoint, String> {
    tauri::async_runtime::spawn_blocking(|| {
        ensure_hostd(&panehost_protocol::data_dir()).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![get_endpoint])
        .run(tauri::generate_context!())
        .expect("error while running Panehost");
}
```

Run: `cargo build -p panehost && cargo clippy --workspace --all-targets -- -D warnings`
Expected: builds; no warnings.

- [ ] **Step 6: Run the app in dev mode**

Run: `pnpm dev` (from the repo root)
Expected: Vite starts, the Panehost window opens, and the status bar shows "Connecting…" then disappears into the empty state. `Get-Process panehost-hostd` shows one hostd.
If Tauri reports it cannot find `ui` for `beforeDevCommand`, change the two build commands in `tauri.conf.json` to the object form `{"script": "pnpm dev", "cwd": "../../ui"}` / `{"script": "pnpm build", "cwd": "../../ui"}` and retry.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml scripts crates/app Cargo.lock
git commit -m "feat(app): Tauri shell that discovers or launches hostd"
```

---

### Task 13: End-to-end acceptance + README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: verified Plan 1 build and developer documentation.

- [ ] **Step 1: Run every automated check**

Run: `pnpm test && cargo clippy --workspace --all-targets -- -D warnings && pnpm --dir ui typecheck`
Expected: all Rust + TS tests PASS, generated TS types unchanged, no clippy warnings, clean typecheck.

- [ ] **Step 2: Manual acceptance (release build)**

```powershell
Stop-Process -Name panehost-hostd -ErrorAction SilentlyContinue
pnpm build
.\target\release\panehost.exe
```
Verify and record results:
1. Window opens; no console windows appear for the app or hostd.
2. Start 3 Claude panes (Claude Code type, three different project folders) and 1 shell pane running `npm run dev` (or `ping -t localhost`). Grid is 2×2; Claude's UI renders correctly and accepts input.
3. Close the window. `Get-Process panehost-hostd` → still running. Wait 30 s.
4. Relaunch `panehost.exe` → all 4 panes return with scrollback; Claude panes repaint cleanly (redraw nudge); the dev server kept running.
5. Launch `panehost.exe` a second time while the first is open → the existing window is focused, no second window.
6. `Stop-Process -Name panehost-hostd` while the app is open → banner shows, the app respawns hostd within a few seconds, the grid comes back **empty** (sessions are lost on a hostd crash in Plan 1 — resume arrives in Plan 3).
7. Typing latency in a PowerShell pane feels identical to Windows Terminal.
8. Logs exist at `%APPDATA%\Panehost\logs\hostd.<date>.log`.

- [ ] **Step 3: Write the README**

`README.md`:
````markdown
# Panehost

A Windows desktop dashboard that keeps many terminals — especially Claude Code sessions — visible on one screen. Sessions live in a background service, so closing or crashing the window never kills them.

## Layout

- `crates/protocol` — shared wire types (generates `ui/src/protocol/generated/*.ts`)
- `crates/hostd` — background service (`panehost-hostd.exe`): ConPTY sessions, 4 MB history per pane, WebSocket on 127.0.0.1
- `crates/app` — Tauri 2 window (`panehost.exe`): finds or launches hostd
- `ui` — React + xterm.js front end
- `docs/superpowers/` — design spec and implementation plans

## Develop

Prereqs: Rust 1.96+, Node 24+, pnpm 11+, WebView2 (ships with Windows 11).

```powershell
pnpm install
pnpm dev          # builds hostd, starts Vite + the Tauri window
pnpm test         # Rust + TS tests, checks generated TS types are committed
pnpm build        # release exes in target\release (no installer yet)
```

UI-only iteration in a browser: start `target\debug\panehost-hostd.exe`, read `%APPDATA%\Panehost\hostd.json`, run `pnpm --dir ui dev`, open `http://localhost:5173/?port=<port>&token=<token>`.

## Working with the background service

- hostd keeps running after the window closes — that is the point. Stop it with `Stop-Process -Name panehost-hostd` (this ends every session).
- After changing hostd code, stop the running hostd first: Windows locks the running exe, so `cargo build` fails with "Access is denied", and the app would otherwise keep talking to the old build.
- Logs: `%APPDATA%\Panehost\logs\`. Set `PANEHOST_LOG=debug` for verbose output.
- `PANEHOST_DATA_DIR` points hostd and the app at a different data folder (used by tests; handy for a second dev instance).

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl+Shift+T` | New pane |
| `Ctrl+Shift+Enter` | Zoom / restore focused pane |
| `Alt+1…9` | Focus pane N |
````

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README with dev workflow and hostd operations"
```

---

## Spec coverage (Plan 1)

| Spec section | Covered here | Deferred |
|---|---|---|
| §3 Architecture: protocol, hostd, app, ui; direct UI↔hostd; discovery; auth; single instance | Tasks 1–2, 5–7, 10, 12 | `hook` crate → Plan 2 |
| §3 Version skew | `VersionMismatch` + fatal banner (Tasks 6, 10) | Restart-with-resume flow → Plan 3 |
| §4 Spawn, attach/reattach, redraw nudge, backpressure resync | Tasks 5, 6, 11 | — |
| §4 Pane state machine | shell states (running/exited/error) | claude states, `active` pulse → Plan 2 |
| §4 Claude hooks, tokens/cost, alerts | env vars injected (Task 7) | → Plan 2 |
| §4 Broadcast, snippets, workspaces, window lifecycle (tray) | — | → Plans 2–3 |
| §5 UI: auto-grid, zoom, pane header, Alt+N, Ctrl+Shift+T, fonts, dark tokens, motion | Tasks 9, 11 | drawer, palette, waiting emphasis, overflow strip, reorder, light theme → Plans 2–3 |
| §6 Persistence | `hostd.json`, logs | settings/workspaces/snippets/panes.json → Plan 3 |
| §7 Error handling | hostd start timeout, reconnect backoff + respawn via `get_endpoint`, spawn-failure pane, unknown pane errors | `.bad` state files, settings.json install errors → Plans 2–3 |
| §8 Testing | protocol, hostd unit + integration + binary, launcher, UI Vitest | Playwright suite → Plan 3 |
