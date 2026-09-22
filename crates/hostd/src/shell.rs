use std::path::PathBuf;

use panehost_protocol::{PaneKind, ShellSpec, SpawnRequest};

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
        assert_eq!(cmd.program, "wsl.exe");
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
