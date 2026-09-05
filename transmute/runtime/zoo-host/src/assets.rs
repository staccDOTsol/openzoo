//! `static/` on PDAs, plus the site manifest.
//!
//! Path → PDA `["asset", sha256("zoo-asset" ‖ path)]`. Account data:
//! `[u8 ver=1][u8 bump][u32 total_len][u8 ct_len][ct bytes][file bytes...]`.
//!
//! Writes are gated by the program's upgrade authority: the caller passes the
//! BPF upgradeable loader's ProgramData account and must sign as the
//! authority recorded in it. A program whose authority was burned has a
//! frozen frontend, which is the right default for "deployed to mainnet".
use crate::{kv::err_str, ERR_NOT_AUTHORITY};
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult, Resize,
};
use pinocchio_system::instructions::{CreateAccount, Transfer};

pub const FIXED_HEADER: usize = 7;
/// Largest account a single CPI `create_account` may allocate.
pub const MAX_INITIAL: usize = 10_240;
pub const MAX_GROW: usize = 10_240;

pub const BPF_LOADER_UPGRADEABLE: Address = Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");

pub fn path_hash(path: &str) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[b"zoo-asset", path.as_bytes()]).to_bytes()
}

pub fn pda_for_hash(program_id: &Address, hash: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[b"asset", hash], program_id)
}

/// Verify `accounts[0]` signs as the upgrade authority of `program_id`
/// (read off `accounts[1]`, the ProgramData account).
pub fn check_authority(program_id: &Address, accounts: &[AccountView]) -> ProgramResult {
    let authority = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let program_data = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected, _) = Address::find_program_address(&[program_id.as_ref()], &BPF_LOADER_UPGRADEABLE);
    if *program_data.address() != expected || !program_data.owned_by(&BPF_LOADER_UPGRADEABLE) {
        return Err(ProgramError::Custom(ERR_NOT_AUTHORITY));
    }
    let d = program_data.try_borrow()?;
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }
    // bincode: u32 enum tag (3) | u64 slot | u8 option | 32 bytes
    if d.len() < 45 || u32::from_le_bytes([d[0], d[1], d[2], d[3]]) != 3 || d[12] != 1 {
        return Err(ProgramError::Custom(ERR_NOT_AUTHORITY));
    }
    if d[13..45] != authority.address().as_ref()[..] {
        return Err(ProgramError::Custom(ERR_NOT_AUTHORITY));
    }
    Ok(())
}

fn split_hash(data: &[u8]) -> Result<(&[u8; 32], &[u8]), ProgramError> {
    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (h, rest) = data.split_at(32);
    Ok((h.try_into().unwrap(), rest))
}

/// `[32 hash][u32 total_len][u8 ct_len][ct]`; accounts: authority, program
/// data, asset PDA, system program.
pub fn init(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    check_authority(program_id, accounts)?;
    let (hash, rest) = split_hash(data)?;
    if rest.len() < 5 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let total = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
    let ct_len = rest[4] as usize;
    let ct = rest.get(5..5 + ct_len).ok_or(ProgramError::InvalidInstructionData)?;
    let header = FIXED_HEADER + ct_len;
    let (addr, bump) = pda_for_hash(program_id, hash);
    let (head, tail) = accounts.split_at_mut(2);
    let authority = &head[0];
    let asset = tail.first_mut().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if *asset.address() != addr {
        return Err(ProgramError::InvalidSeeds);
    }
    let space = (header + total).min(MAX_INITIAL).max(header);
    if asset.owned_by(program_id) {
        // Re-init of an existing asset (redeploy): resize to the new header.
        let rent = Rent::get()?;
        let min = rent.try_minimum_balance(space)?;
        if min > asset.lamports() {
            Transfer { from: authority, to: asset, lamports: min - asset.lamports() }.invoke()?;
        }
        asset.resize(space)?;
    } else {
        let bump_bytes = [bump];
        let seeds = [Seed::from(b"asset".as_ref()), Seed::from(hash.as_ref()), Seed::from(bump_bytes.as_ref())];
        let signer = Signer::from(&seeds);
        CreateAccount::with_minimum_balance(authority, asset, space as u64, program_id, None)?
            .invoke_signed(&[signer])?;
    }
    let mut d = asset.try_borrow_mut()?;
    d[0] = 1;
    d[1] = bump;
    d[2..6].copy_from_slice(&(total as u32).to_le_bytes());
    d[6] = ct_len as u8;
    d[7..7 + ct_len].copy_from_slice(ct);
    Ok(())
}

/// `[32 hash][u32 offset][bytes]`; same accounts as `init`.
pub fn write(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    check_authority(program_id, accounts)?;
    let (hash, rest) = split_hash(data)?;
    if rest.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let offset = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
    let bytes = &rest[4..];
    let (addr, _) = pda_for_hash(program_id, hash);
    let (head, tail) = accounts.split_at_mut(2);
    let authority = &head[0];
    let asset = tail.first_mut().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if *asset.address() != addr || !asset.owned_by(program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let (header, total) = {
        let d = asset.try_borrow()?;
        if d.len() < FIXED_HEADER || d[0] != 1 {
            return Err(ProgramError::InvalidAccountData);
        }
        (FIXED_HEADER + d[6] as usize, u32::from_le_bytes([d[2], d[3], d[4], d[5]]) as usize)
    };
    let end = header + offset + bytes.len();
    if offset + bytes.len() > total {
        return Err(ProgramError::InvalidInstructionData);
    }
    if end > asset.data_len() {
        if end - asset.data_len() > MAX_GROW {
            return Err(ProgramError::InvalidRealloc);
        }
        let rent = Rent::get()?;
        let min = rent.try_minimum_balance(end)?;
        if min > asset.lamports() {
            Transfer { from: authority, to: asset, lamports: min - asset.lamports() }.invoke()?;
        }
        asset.resize(end)?;
    }
    let mut d = asset.try_borrow_mut()?;
    d[header + offset..end].copy_from_slice(bytes);
    Ok(())
}

/// `[32 hash]`: reclaim the rent to the authority.
pub fn close(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    check_authority(program_id, accounts)?;
    let (hash, _) = split_hash(data)?;
    let (addr, _) = pda_for_hash(program_id, hash);
    let (head, tail) = accounts.split_at_mut(2);
    let authority = &mut head[0];
    let asset = tail.first_mut().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if *asset.address() != addr || !asset.owned_by(program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let lamports = asset.lamports();
    asset.set_lamports(0);
    authority.set_lamports(authority.lamports() + lamports);
    asset.close()?;
    let _ = err_str; // keep the helper linked for kv
    Ok(())
}
