//! Pure escrow state-machine logic, kept free of Anchor account plumbing so it
//! can be unit-tested exhaustively with `cargo test`. The instruction handlers
//! call these to validate a transition, then perform the lamport move.

use anchor_lang::prelude::*;

use crate::error::BosphorError;

/// Escrow lifecycle status codes stored in `EscrowVault::status`.
pub const ESCROW_PENDING: u8 = 0;
pub const ESCROW_RELEASED: u8 = 1;
pub const ESCROW_REFUNDED: u8 = 2;

/// Validate that a release is allowed: the escrow must be Pending. Release is
/// authorized by a genuine proof (the caller only reaches this after the endpoint
/// clear + blob-id match), never by an address, and only once.
pub fn check_release(status: u8) -> Result<()> {
    require!(status == ESCROW_PENDING, BosphorError::EscrowNotPending);
    Ok(())
}

/// Validate that a refund is allowed: the escrow must be Pending and the deadline
/// must have passed. Permissionless, and only once.
pub fn check_refund(status: u8, now_unix: i64, deadline: u64) -> Result<()> {
    require!(status == ESCROW_PENDING, BosphorError::EscrowNotPending);
    require!(
        (now_unix as i128) > (deadline as i128),
        BosphorError::DeadlineNotReached
    );
    Ok(())
}

/// Move `amount` lamports from a program-owned account to another by direct
/// lamport math (valid because the vault is program-owned). Checked arithmetic
/// throughout so an underflow/overflow fails loud rather than wrapping.
pub fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;
    **from_lamports = from_lamports
        .checked_sub(amount)
        .ok_or(BosphorError::InsufficientFunds)?;
    **to_lamports = to_lamports
        .checked_add(amount)
        .ok_or(BosphorError::InsufficientFunds)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_allowed_only_when_pending() {
        assert!(check_release(ESCROW_PENDING).is_ok());
        assert!(check_release(ESCROW_RELEASED).is_err());
        assert!(check_release(ESCROW_REFUNDED).is_err());
    }

    #[test]
    fn refund_requires_pending_and_past_deadline() {
        let deadline = 1_000u64;
        // Pending + past deadline -> ok.
        assert!(check_refund(ESCROW_PENDING, 1_001, deadline).is_ok());
        // Pending + exactly at deadline -> not yet.
        assert!(check_refund(ESCROW_PENDING, 1_000, deadline).is_err());
        // Pending + before deadline -> not yet.
        assert!(check_refund(ESCROW_PENDING, 999, deadline).is_err());
        // Already released -> cannot refund even past deadline.
        assert!(check_refund(ESCROW_RELEASED, 2_000, deadline).is_err());
        // Already refunded -> cannot refund again.
        assert!(check_refund(ESCROW_REFUNDED, 2_000, deadline).is_err());
    }

    #[test]
    fn move_lamports_transfers_and_checks_bounds() {
        let key_a = Pubkey::new_unique();
        let key_b = Pubkey::new_unique();
        let mut la = 1_000u64;
        let mut lb = 500u64;
        let mut da: Vec<u8> = vec![];
        let mut db: Vec<u8> = vec![];
        let owner = Pubkey::new_unique();

        let a = AccountInfo::new(&key_a, false, false, &mut la, &mut da, &owner, false, 0);
        let b = AccountInfo::new(&key_b, false, false, &mut lb, &mut db, &owner, false, 0);

        move_lamports(&a, &b, 300).unwrap();
        assert_eq!(**a.lamports.borrow(), 700);
        assert_eq!(**b.lamports.borrow(), 800);

        // Overdraw the source -> InsufficientFunds, no partial move.
        assert!(move_lamports(&a, &b, 10_000).is_err());
        assert_eq!(**a.lamports.borrow(), 700);
        assert_eq!(**b.lamports.borrow(), 800);
    }
}
