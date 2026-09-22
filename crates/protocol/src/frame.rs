use crate::PaneId;

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
