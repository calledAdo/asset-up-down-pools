//! Round-trip and invariant tests for the PoolData layout and the grace fn.

#[cfg(test)]
mod tests {
    use up_down_common::constants::*;
    use up_down_common::pool_data::{PoolData, POOL_LEN_CKB, POOL_LEN_XUDT};

    fn sample(variant: u8) -> PoolData {
        PoolData {
            variant,
            asset_type_hash: if variant == VARIANT_XUDT {
                Some([0xAB; 32])
            } else {
                None
            },
            share_xudt_code_hash: [0xCD; 32],
            treasury_lock_code_hash: if variant == VARIANT_XUDT {
                Some([0xEF; 32])
            } else {
                None
            },
            feed_id: [0x11; 32],
            oracle_commit: up_down_common::oracle_read::oracle_commit(
                &ORACLE_TYPE_CODE_HASH,
                &GUARDIAN_SET_TYPE_HASH,
                PYTH_EMITTER_CHAIN,
                &PYTH_EMITTER_ADDRESS,
            ),
            start_time: 1_700_000_000,
            close_time: 1_700_000_900,
            up_total: 123_456_789_000,
            down_total: 987_654_321,
            start_price: -42, // signed round-trip
            settle_price: 64_250_000_000,
            used_pt: 1_700_000_123,
            rake_bps: 150,
            status: STATUS_LOCKED,
            winner: SIDE_UNDECIDED,
        }
    }

    #[test]
    fn ckb_round_trip() {
        let p = sample(VARIANT_CKB);
        let bytes = p.to_bytes();
        assert_eq!(bytes.len(), POOL_LEN_CKB);
        assert_eq!(PoolData::from_bytes(&bytes), Some(p));
    }

    #[test]
    fn xudt_round_trip() {
        let p = sample(VARIANT_XUDT);
        let bytes = p.to_bytes();
        assert_eq!(bytes.len(), POOL_LEN_XUDT);
        assert_eq!(PoolData::from_bytes(&bytes), Some(p));
    }

    #[test]
    fn rejects_wrong_length() {
        let mut bytes = sample(VARIANT_CKB).to_bytes();
        bytes.push(0);
        assert_eq!(PoolData::from_bytes(&bytes), None);
    }

    #[test]
    fn rejects_unknown_variant() {
        let mut bytes = sample(VARIANT_CKB).to_bytes();
        bytes[0] = 9;
        assert_eq!(PoolData::from_bytes(&bytes), None);
    }

    #[test]
    fn config_unchanged_detects_mutation() {
        let a = sample(VARIANT_XUDT);
        let mut b = a.clone();
        // mutable state may change
        b.up_total += 1000;
        b.status = STATUS_SETTLED;
        assert!(a.config_unchanged(&b));
        // config may not
        b.rake_bps += 1;
        assert!(!a.config_unchanged(&b));

        let mut c = a.clone();
        c.share_xudt_code_hash = [0xCC; 32];
        assert!(!a.config_unchanged(&c));

        let mut d = a.clone();
        d.treasury_lock_code_hash = Some([0xDD; 32]);
        assert!(!a.config_unchanged(&d));
    }

    #[test]
    fn grace_scales_and_clamps() {
        assert_eq!(grace(15 * 60), 90); // 900/10
        assert_eq!(grace(60 * 60), 360); // 3600/10
        assert_eq!(grace(24 * 60 * 60), GRACE_MAX_SECS); // capped
        assert_eq!(grace(10), GRACE_MIN_SECS); // floored
    }
}
