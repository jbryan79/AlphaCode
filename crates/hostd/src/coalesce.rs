use std::time::Duration;

use tokio::sync::mpsc::Receiver;
use tokio::time::{timeout_at, Instant};

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
