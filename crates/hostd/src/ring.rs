use std::collections::VecDeque;

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
