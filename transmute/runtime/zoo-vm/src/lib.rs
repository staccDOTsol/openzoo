//! zoo-vm: the shared runtime program. Sites are data.
//!
//! Instruction data: `[tag][site_id: 32][payload]`.
//! * TAG_SITE_INIT          payload = ()                accounts: authority, site PDA, system
//! * TAG_SITE_SET_AUTHORITY payload = new authority      accounts: authority, site PDA
//! * TAG_VM_ASSET_INIT/WRITE/CLOSE payload = as the compiled-site asset tags
//!                          accounts: authority, site PDA, asset PDA, system
//! * TAG_VM_INVOKE          payload = bridge event (wire::Req)
//!                          accounts: payer, system, site PDA, code asset, ...kv PDAs
#![no_std]
extern crate alloc;

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};
use zoo_host::{assets, site, vm, wire, Ctx, Val, ERR_BAD_WIRE, ERR_KV_MISSING, TAG_SITE_INIT, TAG_SITE_SET_AUTHORITY, TAG_VM_ASSET_CLOSE, TAG_VM_ASSET_INIT, TAG_VM_ASSET_WRITE, TAG_VM_INVOKE};

pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::Custom(ERR_BAD_WIRE))?;
    match *tag {
        TAG_SITE_INIT => site::init(program_id, accounts, rest),
        TAG_SITE_SET_AUTHORITY => site::set_authority(program_id, accounts, rest),
        TAG_VM_ASSET_INIT => {
            let (id, payload) = site::site_id_from(rest)?;
            assets::init_ns(program_id, accounts, payload, Some(id), assets::Auth::Site(id))
        }
        TAG_VM_ASSET_WRITE => {
            let (id, payload) = site::site_id_from(rest)?;
            assets::write_ns(program_id, accounts, payload, Some(id), assets::Auth::Site(id))
        }
        TAG_VM_ASSET_CLOSE => {
            let (id, payload) = site::site_id_from(rest)?;
            assets::close_ns(program_id, accounts, payload, Some(id), assets::Auth::Site(id))
        }
        TAG_VM_INVOKE => invoke(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn invoke(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (site_id, payload) = site::site_id_from(data)?;
    let req = wire::parse_req(payload).map_err(|_| ProgramError::Custom(ERR_BAD_WIRE))?;
    // accounts[2] = site PDA (identity check), accounts[3] = the code asset.
    let (site_addr, _) = site::site_pda(program_id, &site_id);
    let site_acc = accounts.get(2).ok_or(ProgramError::NotEnoughAccountKeys)?;
    if *site_acc.address() != site_addr || !site_acc.owned_by(program_id) {
        return Err(ProgramError::InvalidSeeds);
    }
    let code_hash = assets::path_hash(zoo_host::CODE_PATH);
    let (code_addr, _) = assets::pda_for_hash_ns(program_id, Some(&site_id), &code_hash);
    let code_acc = accounts.get(3).ok_or(ProgramError::NotEnoughAccountKeys)?;
    if *code_acc.address() != code_addr || !code_acc.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountData);
    }
    // Copy the module out so the account borrow does not outlive the run
    // (the handler may write KV accounts; the code account is never written).
    let code: alloc::vec::Vec<u8> = {
        let d = code_acc.try_borrow()?;
        if d.len() < assets::FIXED_HEADER || d[0] != 1 {
            return Err(ProgramError::InvalidAccountData);
        }
        let total = u32::from_le_bytes([d[2], d[3], d[4], d[5]]) as usize;
        let start = assets::FIXED_HEADER + d[6] as usize;
        d.get(start..start + total).ok_or(ProgramError::InvalidAccountData)?.to_vec()
    };
    let route = req.route as usize;
    let mut cx = Ctx::new(program_id, accounts, req, &[]);
    cx.ns = Some(site_id);
    let outcome = vm::invoke_module(&mut cx, &code, route);
    if !cx.kv.missing.is_empty() {
        for pda in cx.kv.missing.iter() {
            wire::log_kv_missing(pda);
        }
        return Err(ProgramError::Custom(ERR_KV_MISSING));
    }
    match outcome {
        Ok(()) => {}
        Err(thrown) => {
            cx.res = vm::error_resp(&thrown);
            cx.sent = true;
        }
    }
    if !cx.sent {
        cx.res = wire::Resp::json_error(504, "handler returned without a response");
    }
    let bytes = wire::encode_resp(&cx.res);
    wire::emit(&bytes);
    let _ = Val::Undef;
    Ok(())
}
