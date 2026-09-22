use std::{fs, io};
use std::path::{Path, PathBuf};

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
