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

/// No free-form env on purpose: the control token must never be passable into a PTY.
pub struct RegistryConfig {
    pub ring_capacity: usize,
    /// Exposed to panes as PANEHOST_PORT so the Claude hook can reach `POST /hook`.
    pub hostd_port: u16,
}

pub struct Registry {
    config: RegistryConfig,
    panes: RwLock<Vec<Arc<Pane>>>,
    events: broadcast::Sender<ServerMsg>,
    runtime: tokio::runtime::Handle,
}

pub struct Pane {
    id: PaneId,
    /// Per-pane secret for `POST /hook` only; never accepted by the WebSocket.
    hook_token: String,
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
        let hook_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
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

        let (io, pumps) = match self.start_process(id, &hook_token, &req, &cwd) {
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
            hook_token,
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

    fn start_process(&self, id: PaneId, hook_token: &str, req: &SpawnRequest, cwd: &Path) -> Result<Started> {
        anyhow::ensure!(cwd.is_dir(), "working directory not found: {}", cwd.display());
        let pair = native_pty_system()
            .openpty(PtySize { rows: DEFAULT_ROWS, cols: DEFAULT_COLS, pixel_width: 0, pixel_height: 0 })
            .context("failed to open pseudoconsole")?;

        let shell = build_command(req);
        let mut cmd = CommandBuilder::new(&shell.program);
        cmd.args(&shell.args);
        cmd.cwd(cwd);
        cmd.env("PANEHOST_PANE_ID", id.to_string());
        cmd.env("PANEHOST_PORT", self.config.hostd_port.to_string());
        cmd.env("PANEHOST_HOOK_TOKEN", hook_token);
        // Defence in depth: never let a control token inherited by hostd leak into a pane.
        cmd.env_remove("PANEHOST_TOKEN");

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
            let mut held = Vec::new();
            while let Some(batch) = next_batch(&mut chunk_rx, BATCH_MAX_BYTES, BATCH_WINDOW).await {
                let Some(pane) = weak_pane.upgrade() else { break };
                held.extend_from_slice(&batch);
                let (out, queries) = strip_cursor_queries(&mut held);
                for _ in 0..queries {
                    pane.write(DSR_REPLY);
                }
                if !out.is_empty() {
                    pane.publish(&out);
                }
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

/// ConPTY asks the terminal where the cursor is (DSR, `ESC[6n`) before it writes anything and
/// waits for the answer. hostd is headless, so it answers itself and drops the query from the
/// stream: a client replaying the ring later must never answer a stale query as keystrokes.
const DSR_QUERY: &[u8] = b"\x1b[6n";
const DSR_REPLY: &[u8] = b"\x1b[1;1R";

/// Removes every complete query from `held`, returning the publishable bytes and the query count.
/// A trailing partial query stays in `held` until the next chunk completes or refutes it.
fn strip_cursor_queries(held: &mut Vec<u8>) -> (Vec<u8>, usize) {
    let mut out = Vec::with_capacity(held.len());
    let mut queries = 0;
    let mut i = 0;
    while i < held.len() {
        let rest = &held[i..];
        if rest.starts_with(DSR_QUERY) {
            queries += 1;
            i += DSR_QUERY.len();
        } else if DSR_QUERY.starts_with(rest) {
            break; // partial query at the end: wait for more bytes
        } else {
            out.push(held[i]);
            i += 1;
        }
    }
    held.drain(..i);
    (out, queries)
}

impl Pane {
    pub fn id(&self) -> PaneId {
        self.id
    }

    pub fn hook_token(&self) -> &str {
        &self.hook_token
    }

    /// Constant-time comparison so response timing reveals nothing about the token.
    pub fn hook_token_matches(&self, candidate: &str) -> bool {
        let (a, b) = (self.hook_token.as_bytes(), candidate.as_bytes());
        a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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

#[cfg(test)]
mod dsr_tests {
    use super::*;

    #[test]
    fn strips_queries_even_when_split_across_chunks() {
        let mut held = b"ab\x1b[6ncd\x1b[".to_vec();
        assert_eq!(strip_cursor_queries(&mut held), (b"abcd".to_vec(), 1));
        assert_eq!(held, b"\x1b[");
        held.extend_from_slice(b"6nef\x1b");
        assert_eq!(strip_cursor_queries(&mut held), (b"ef".to_vec(), 1));
        held.extend_from_slice(b"[0m");
        assert_eq!(strip_cursor_queries(&mut held), (b"\x1b[0m".to_vec(), 0));
        assert!(held.is_empty());
    }
}
