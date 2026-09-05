//! `@vercel/kv` on PDAs.
//!
//! Key → PDA `["kv", sha256(key)]`. Account data:
//! `[u8 ver=1][u8 bump][u32 len][len bytes of JSON]`.
//!
//! The gateway does not know which keys a handler will touch, so the program
//! discovers them: a key whose PDA is not in the account list is recorded in
//! [`KvState::missing`] and the invoke fails with `ERR_KV_MISSING`; the
//! gateway reads the `ZOOK` logs, appends those PDAs and retries. Accounts
//! `0` and `1` are the payer and the system program.
use crate::json;
use crate::val::Val;
use crate::Ctx;
use alloc::{string::String, vec::Vec};
use pinocchio::{
    cpi::{Seed, Signer},
    sysvars::{rent::Rent, Sysvar},
    Address, Resize,
};
use pinocchio_system::instructions::{CreateAccount, Transfer};

pub const HEADER: usize = 6;
pub const MAX_VALUE: usize = 10_000;

#[derive(Default)]
pub struct KvState {
    pub missing: Vec<Address>,
}

/// The sentinel thrown into the handler when a KV account is missing; the
/// dispatcher looks at `missing` first, so this never reaches the response.
pub const MISSING_SENTINEL: &str = "__ZOO_KV_MISSING__";

pub fn key_hash(key: &str) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[b"zoo-kv", key.as_bytes()]).to_bytes()
}

pub fn pda_for(program_id: &Address, key: &str) -> (Address, u8, [u8; 32]) {
    let h = key_hash(key);
    let (a, bump) = Address::find_program_address(&[b"kv", &h], program_id);
    (a, bump, h)
}

struct Slot {
    idx: usize,
    bump: u8,
    hash: [u8; 32],
}

impl<'a> Ctx<'a> {
    fn kv_slot(&mut self, key: &Val) -> Result<Slot, Val> {
        let k = key.to_js_string();
        let (addr, bump, hash) = pda_for(self.program_id, &k);
        match self.accounts.iter().position(|a| *a.address() == addr) {
            Some(idx) => Ok(Slot { idx, bump, hash }),
            None => {
                if !self.kv.missing.iter().any(|m| *m == addr) {
                    self.kv.missing.push(addr);
                }
                Err(Val::str(MISSING_SENTINEL))
            }
        }
    }

    fn kv_read(&self, idx: usize) -> Val {
        let acc = &self.accounts[idx];
        if !acc.owned_by(self.program_id) || acc.data_len() < HEADER {
            return Val::Null;
        }
        let d = match acc.try_borrow() {
            Ok(d) => d,
            Err(_) => return Val::Null,
        };
        let len = u32::from_le_bytes([d[2], d[3], d[4], d[5]]) as usize;
        if len == 0 || HEADER + len > d.len() {
            return Val::Null;
        }
        let text = match core::str::from_utf8(&d[HEADER..HEADER + len]) {
            Ok(t) => t,
            Err(_) => return Val::Null,
        };
        json::parse(text).unwrap_or(Val::Null)
    }

    /// `kv.get(key)` → value or null.
    pub fn kv_get(&mut self, key: &Val) -> Result<Val, Val> {
        let s = self.kv_slot(key)?;
        Ok(self.kv_read(s.idx))
    }

    /// `kv.exists(key)` → 0 | 1
    pub fn kv_exists(&mut self, key: &Val) -> Result<Val, Val> {
        let s = self.kv_slot(key)?;
        Ok(Val::Num(if self.kv_read(s.idx).is_nullish() { 0.0 } else { 1.0 }))
    }

    /// `kv.set(key, value)` → "OK"
    pub fn kv_set(&mut self, key: &Val, value: &Val) -> Result<Val, Val> {
        let s = self.kv_slot(key)?;
        let payload = json::stringify(value).into_bytes();
        if payload.len() > MAX_VALUE {
            return Err(Val::str("kv.set: value exceeds 10000 bytes"));
        }
        self.kv_write(&s, &payload)?;
        Ok(Val::str("OK"))
    }

    /// `kv.incr(key)` / `kv.incrby(key, n)` / `kv.decr`
    pub fn kv_incrby(&mut self, key: &Val, by: &Val) -> Result<Val, Val> {
        let s = self.kv_slot(key)?;
        let cur = self.kv_read(s.idx);
        let n = if cur.is_nullish() { 0.0 } else { cur.to_num() };
        if n.is_nan() {
            return Err(Val::str("ERR value is not an integer or out of range"));
        }
        let next = Val::Num(n + by.to_num());
        let payload = json::stringify(&next).into_bytes();
        self.kv_write(&s, &payload)?;
        Ok(next)
    }

    /// `kv.del(key)` → number of keys removed (0 | 1)
    pub fn kv_del(&mut self, key: &Val) -> Result<Val, Val> {
        let s = self.kv_slot(key)?;
        if self.kv_read(s.idx).is_nullish() {
            return Ok(Val::Num(0.0));
        }
        self.kv_write(&s, &[])?;
        Ok(Val::Num(1.0))
    }

    fn kv_write(&mut self, s: &Slot, payload: &[u8]) -> Result<(), Val> {
        let need = HEADER + payload.len();
        let program_id = self.program_id;
        let bump = [s.bump];
        if self.accounts.len() < 2 {
            return Err(Val::str("kv.set: payer and system program accounts required"));
        }
        if s.idx < 2 {
            return Err(Val::str("kv: account layout violated"));
        }
        let (head, tail) = self.accounts.split_at_mut(s.idx);
        let payer = &head[0];
        let acc = &mut tail[0];
        if !acc.owned_by(program_id) {
            // First write: create the PDA.
            if !payer.is_signer() {
                return Err(Val::str("kv.set: payer must sign"));
            }
            let seeds = [Seed::from(b"kv".as_ref()), Seed::from(s.hash.as_ref()), Seed::from(bump.as_ref())];
            let signer = Signer::from(&seeds);
            CreateAccount::with_minimum_balance(payer, acc, need as u64, program_id, None)
                .map_err(|e| Val::Str(err_str("kv create", e)))?
                .invoke_signed(&[signer])
                .map_err(|e| Val::Str(err_str("kv create", e)))?;
        } else if need > acc.data_len() {
            let rent = Rent::get().map_err(|e| Val::Str(err_str("rent", e)))?;
            let min = rent.try_minimum_balance(need).map_err(|e| Val::Str(err_str("rent", e)))?;
            if min > acc.lamports() {
                Transfer { from: payer, to: acc, lamports: min - acc.lamports() }
                    .invoke()
                    .map_err(|e| Val::Str(err_str("kv rent", e)))?;
            }
            acc.resize(need).map_err(|e| Val::Str(err_str("kv resize", e)))?;
        } else if need < acc.data_len() && payload.is_empty() {
            acc.resize(HEADER).map_err(|e| Val::Str(err_str("kv resize", e)))?;
        }
        let mut d = acc.try_borrow_mut().map_err(|e| Val::Str(err_str("kv borrow", e)))?;
        d[0] = 1;
        d[1] = s.bump;
        d[2..6].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        if !payload.is_empty() {
            d[HEADER..HEADER + payload.len()].copy_from_slice(payload);
        }
        Ok(())
    }
}

pub fn err_str(what: &str, e: pinocchio::error::ProgramError) -> String {
    let code: u64 = e.into();
    alloc::format!("{} failed: program error {}", what, code)
}
