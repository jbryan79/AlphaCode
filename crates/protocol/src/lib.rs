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
