use std::io::Read;
use std::time::{Duration, Instant};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn main() {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 32, cols: 120, pixel_width: 0, pixel_height: 0 })
        .unwrap();
    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.args(["/C", "echo hello-marker"]);
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let start = Instant::now();
    let mut buf = [0u8; 8192];
    let mut all = Vec::new();
    // read for up to 20s, no writer response at all
    let deadline = start + Duration::from_secs(20);
    loop {
        if Instant::now() > deadline { println!("TIMEOUT after {:?}", start.elapsed()); break; }
        match reader.read(&mut buf) {
            Ok(0) => { println!("EOF after {:?}", start.elapsed()); break; }
            Ok(n) => {
                all.extend_from_slice(&buf[..n]);
                println!("[{:?}] read {} bytes: {:?}", start.elapsed(), n, String::from_utf8_lossy(&buf[..n]));
                if String::from_utf8_lossy(&all).contains("hello-marker") {
                    println!("GOT MARKER at {:?}", start.elapsed());
                    break;
                }
            }
            Err(e) => { println!("ERR {:?} at {:?}", e, start.elapsed()); break; }
        }
    }
    let _ = child.wait();
    println!("FULL OUTPUT: {:?}", String::from_utf8_lossy(&all));
}
