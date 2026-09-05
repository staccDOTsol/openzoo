//! The shared runtime's site registry.
//!
//! Under the shared runtime program a site is not a program: it is a site
//! account `["site", site_id]` naming its authority, a code asset
//! (`/.zoo/code.bin`, the bytecode module), its static assets and its
//! manifest, all PDAs of the runtime program namespaced by `site_id`, plus KV
//! accounts `["kv", site_id, hash]`. `site_id` is any 32-byte id the deployer
//! picks (the CLI uses a fresh keypair's public key so ids look like programs).
use crate::ERR_NOT_AUTHORITY;
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

pub const SITE_LEN: usize = 2 + 32 + 32; // ver, bump, authority, reserved

pub fn site_pda(program_id: &Address, site_id: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[b"site", site_id], program_id)
}

/// `accounts[0]` must sign as the authority recorded in the site account at `accounts[1]`.
pub fn check_site_authority(program_id: &Address, accounts: &[AccountView], site_id: &[u8; 32]) -> ProgramResult {
    let authority = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let site = accounts.get(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (expected, _) = site_pda(program_id, site_id);
    if *site.address() != expected || !site.owned_by(program_id) {
        return Err(ProgramError::Custom(ERR_NOT_AUTHORITY));
    }
    let d = site.try_borrow()?;
    if d.len() < SITE_LEN || d[0] != 1 || d[2..34] != authority.address().as_ref()[..] {
        return Err(ProgramError::Custom(ERR_NOT_AUTHORITY));
    }
    Ok(())
}

/// `[32 site_id]`; accounts: authority (signer, pays), site PDA (writable), system program.
/// Creates the site account owned by the runtime with `authority` in charge.
pub fn init(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut site_id = [0u8; 32];
    site_id.copy_from_slice(&data[..32]);
    let (head, tail) = accounts.split_at_mut(1);
    let authority = &head[0];
    let site = tail.first_mut().ok_or(ProgramError::NotEnoughAccountKeys)?;
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (addr, bump) = site_pda(program_id, &site_id);
    if *site.address() != addr {
        return Err(ProgramError::InvalidSeeds);
    }
    if site.owned_by(program_id) {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let bump_bytes = [bump];
    let seeds = [Seed::from(b"site".as_ref()), Seed::from(site_id.as_ref()), Seed::from(bump_bytes.as_ref())];
    let signer = Signer::from(&seeds);
    CreateAccount::with_minimum_balance(authority, site, SITE_LEN as u64, program_id, None)?.invoke_signed(&[signer])?;
    let mut d = site.try_borrow_mut()?;
    d[0] = 1;
    d[1] = bump;
    d[2..34].copy_from_slice(authority.address().as_ref());
    Ok(())
}

/// `[32 site_id][32 new_authority]`; accounts: authority (signer), site PDA (writable).
pub fn set_authority(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if data.len() < 64 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut site_id = [0u8; 32];
    site_id.copy_from_slice(&data[..32]);
    check_site_authority(program_id, accounts, &site_id)?;
    let site = accounts.get_mut(1).ok_or(ProgramError::NotEnoughAccountKeys)?;
    let mut d = site.try_borrow_mut()?;
    d[2..34].copy_from_slice(&data[32..64]);
    Ok(())
}

pub fn site_id_from(data: &[u8]) -> Result<([u8; 32], &[u8]), ProgramError> {
    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut id = [0u8; 32];
    id.copy_from_slice(&data[..32]);
    Ok((id, &data[32..]))
}
