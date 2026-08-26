// SentinelVault CVE_LOOKUP scoring module (Track 2 / Script Author).
// A no_std WASM module that scores a miner's CVE answer against ground truth.
// Weights: CVE id match (0.40) + severity match (0.25) + CVSS score match
// (0.15) + description word overlap (0.20). Rewards exact answers, penalises
// wrong CVEs / wrong severities, and keeps real score spread so it separates
// good from bad answers.
#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

// ---- memory management (bump allocator, required interface) ----
const HEAP_SIZE: usize = 1 * 1024 * 1024;
static mut HEAP: [u8; HEAP_SIZE] = [0u8; HEAP_SIZE];
static mut HEAP_OFFSET: usize = 0;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn alloc(size: i32) -> i32 {
    let size = size.max(0) as usize;
    unsafe {
        let aligned = (HEAP_OFFSET + 3) & !3;
        if aligned + size > HEAP_SIZE {
            HEAP_OFFSET = 0;
        } else {
            HEAP_OFFSET = aligned;
        }
        let ptr = core::ptr::addr_of_mut!(HEAP).cast::<u8>().add(HEAP_OFFSET);
        HEAP_OFFSET += size;
        ptr as i32
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(_ptr: i32, _size: i32) {}

unsafe fn read_str<'a>(ptr: i32, len: i32) -> &'a str {
    unsafe {
        let slice = core::slice::from_raw_parts(ptr as *const u8, len.max(0) as usize);
        core::str::from_utf8_unchecked(slice)
    }
}

// ---- helpers ----
fn eq_ci(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    for i in 0..a.len() {
        if a[i].to_ascii_lowercase() != b[i].to_ascii_lowercase() {
            return false;
        }
    }
    true
}

// case-insensitive substring search on raw bytes (no allocations)
fn ci_contains(hay: &str, needle: &str) -> bool {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() || n.len() > h.len() {
        return false;
    }
    for i in 0..=(h.len() - n.len()) {
        let mut ok = true;
        for k in 0..n.len() {
            if h[i + k].to_ascii_lowercase() != n[k].to_ascii_lowercase() {
                ok = false;
                break;
            }
        }
        if ok {
            return true;
        }
    }
    false
}

// Extract the CVE id token (e.g. "CVE-2021-44228") as a byte slice.
fn extract_cve_id<'a>(s: &'a str) -> Option<&'a str> {
    let b = s.as_bytes();
    let mut i = 0;
    while i + 3 < b.len() {
        if b[i..i + 4].eq_ignore_ascii_case(b"CVE-") {
            let mut j = i + 4;
            let d1 = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > d1 && j < b.len() && b[j] == b'-' {
                let mut j2 = j + 1;
                let d2 = j2;
                while j2 < b.len() && b[j2].is_ascii_digit() {
                    j2 += 1;
                }
                if j2 > d2 {
                    return Some(&s[i..j2]);
                }
            }
        }
        i += 1;
    }
    None
}

// First severity token found in the text (CRITICAL > HIGH > MEDIUM > LOW).
fn extract_severity(s: &str) -> Option<u8> {
    for (i, sev) in ["CRITICAL", "HIGH", "MEDIUM", "LOW"].iter().enumerate() {
        if ci_contains(s, sev) {
            return Some(i as u8);
        }
    }
    None
}

// parse "NNN[.DDD]" bytes to f32 (no std)
fn parse_decimal(bs: &[u8]) -> f32 {
    let mut v = 0.0f32;
    let mut frac = false;
    let mut mult = 0.1f32;
    for &c in bs {
        if c == b'.' {
            frac = true;
            continue;
        }
        if frac {
            v += (c - b'0') as f32 * mult;
            mult *= 0.1;
        } else {
            v = v * 10.0 + (c - b'0') as f32;
        }
    }
    v
}

// First decimal number found in the text, e.g. the CVSS score.
fn extract_score(s: &str) -> Option<f32> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let s2 = i;
            let mut j = i;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j < b.len() && b[j] == b'.' && j + 1 < b.len() && b[j + 1].is_ascii_digit() {
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
            }
            return Some(parse_decimal(&b[s2..j]));
        }
        i += 1;
    }
    None
}

// Casual token overlap between both descriptions.
fn word_overlap(g: &str, m: &str) -> f32 {
    let mut total = 0.0f32;
    let mut matched = 0.0f32;
    for mw in m.split_whitespace() {
        total += 1.0;
        if g.split_whitespace().any(|gw| gw.eq_ignore_ascii_case(mw)) {
            matched += 1.0;
        }
    }
    if total == 0.0 {
        0.0
    } else {
        matched / total
    }
}

fn score(ground_truth: &str, miner_answer: &str) -> f32 {
    if miner_answer.trim().is_empty() {
        return 0.0;
    }
    if miner_answer == ground_truth {
        return 1.0;
    }
    let id_match = match (extract_cve_id(ground_truth), extract_cve_id(miner_answer)) {
        (Some(g), Some(m)) => {
            if eq_ci(g.as_bytes(), m.as_bytes()) {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };
    let sev_match = match (extract_severity(ground_truth), extract_severity(miner_answer)) {
        (Some(a), Some(b)) => {
            if a == b {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };
    let cv_match = match (extract_score(ground_truth), extract_score(miner_answer)) {
        (Some(a), Some(b)) => {
            if (a - b).abs() < 0.5 {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };
    let overlap = word_overlap(ground_truth, miner_answer).min(1.0);

    0.35 * id_match + 0.30 * sev_match + 0.15 * cv_match + 0.20 * overlap
}

// ---- required export ----
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rank_answer(
    q_ptr: i32,
    q_len: i32,
    gt_ptr: i32,
    gt_len: i32,
    ma_ptr: i32,
    ma_len: i32,
) -> f32 {
    unsafe {
        let _question = read_str(q_ptr, q_len);
        let ground_truth = read_str(gt_ptr, gt_len);
        let miner_answer = read_str(ma_ptr, ma_len);
        if miner_answer.trim().is_empty() {
            return 0.0;
        }
        score(ground_truth, miner_answer)
    }
}