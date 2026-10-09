use std::sync::Arc;
use std::time::Duration;

use hostd::registry::{Pane, Registry, RegistryConfig};
use panehost_protocol::{PaneId, PaneKind, PaneStatus, ServerMsg, ShellSpec, SpawnRequest};
use tokio::sync::broadcast::error::RecvError;
use tokio::time::timeout;

const TEST_PORT: u16 = 45678;

fn registry() -> Arc<Registry> {
    Registry::new(RegistryConfig { ring_capacity: 1 << 20, hostd_port: TEST_PORT })
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
    let info = reg.spawn(cmd_request(
        PaneKind::Claude,
        Some("echo port=%PANEHOST_PORT% hook=%PANEHOST_HOOK_TOKEN% id=%PANEHOST_PANE_ID%"),
    ));
    assert_eq!(info.status, PaneStatus::Running);
    let pane = reg.get(info.id).unwrap();
    let text = output_until(&pane, &format!("id={}", info.id)).await;
    assert!(text.contains(&format!("port={TEST_PORT}")), "PANEHOST_PORT missing: {text:?}");
    assert!(text.contains(&format!("hook={}", pane.hook_token())), "PANEHOST_HOOK_TOKEN missing: {text:?}");
    let status = status_until(&reg, info.id, |s| matches!(s, PaneStatus::Exited { .. })).await;
    assert_eq!(status, PaneStatus::Exited { code: 0 });
}

#[tokio::test(flavor = "multi_thread")]
async fn pane_env_never_contains_a_control_token() {
    let reg = registry();
    // %OS% expands only when the branch runs, so the needle cannot come from an echo of the command.
    let info = reg.spawn(cmd_request(
        PaneKind::Claude,
        Some("if defined PANEHOST_TOKEN (echo leak-%OS%) else (echo clean-%OS%)"),
    ));
    let text = output_until(&reg.get(info.id).unwrap(), "-Windows_NT").await;
    assert!(text.contains("clean-Windows_NT"), "PANEHOST_TOKEN reached the pane: {text:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn hook_tokens_are_unique_per_pane_and_checked_exactly() {
    let reg = registry();
    let a = reg.get(reg.spawn(cmd_request(PaneKind::Shell, None)).id).unwrap();
    let b = reg.get(reg.spawn(cmd_request(PaneKind::Shell, None)).id).unwrap();
    assert_eq!(a.hook_token().len(), 64);
    assert_ne!(a.hook_token(), b.hook_token());
    assert!(a.hook_token_matches(a.hook_token()));
    assert!(!a.hook_token_matches(b.hook_token()), "pane A must reject pane B's token");
    assert!(!a.hook_token_matches(""));
    assert!(!a.hook_token_matches(&a.hook_token()[..63]));
    reg.kill(a.id()).unwrap();
    reg.kill(b.id()).unwrap();
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
