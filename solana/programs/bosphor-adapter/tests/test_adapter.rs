//! Instruction-level tests for the Bosphor adapter, run in-process on LiteSVM.
//!
//! LiteSVM is an in-memory SVM: no `solana-test-validator` and no network. The
//! compiled program `.so` is loaded from the anchor build output. These tests
//! cover the submit_intent + mark_executed happy path and the BlobIdMismatch
//! rejection path.
//!
//! If the `.so` is not present (i.e. `anchor build` has not been run), the tests
//! skip with a clear message rather than failing, so `cargo test` on the host is
//! never coupled to an SBF build.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const CONFIG_SEED: &[u8] = b"config";
const NONCE_SEED: &[u8] = b"nonce";
const INTENT_SEED: &[u8] = b"intent";

/// Loads the compiled program into a fresh LiteSVM, or returns `None` if the
/// `.so` has not been built yet.
fn setup() -> Option<(LiteSVM, Pubkey, Keypair)> {
    let so_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/bosphor_adapter.so"
    );
    let bytes = std::fs::read(so_path).ok()?;

    let program_id = bosphor_adapter::id();
    let mut svm = LiteSVM::new();
    svm.add_program(program_id, &bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    Some((svm, program_id, payer))
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ix: Instruction,
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ())
}

fn config_pda(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id).0
}

fn nonce_pda(program_id: &Pubkey, sender: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[NONCE_SEED, sender.as_ref()], program_id).0
}

fn intent_pda(program_id: &Pubkey, intent_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[INTENT_SEED, intent_id.as_ref()], program_id).0
}

fn initialize(svm: &mut LiteSVM, program_id: &Pubkey, payer: &Keypair, authority: Pubkey) {
    let ix = Instruction::new_with_bytes(
        *program_id,
        &bosphor_adapter::instruction::Initialize { authority }.data(),
        bosphor_adapter::accounts::Initialize {
            payer: payer.pubkey(),
            config: config_pda(program_id),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(svm, payer, &[payer], ix).expect("initialize should succeed");
}

#[allow(clippy::too_many_arguments)]
fn submit_intent(
    svm: &mut LiteSVM,
    program_id: &Pubkey,
    payer: &Keypair,
    blob_id: [u8; 32],
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64,
    nonce: u64,
) -> ([u8; 32], Pubkey) {
    let intent_id = bosphor_adapter::instructions::submit_intent::compute_intent_id(
        blob_id,
        size,
        encoding_type,
        storage_epochs,
        deadline,
        &payer.pubkey(),
        nonce,
    );
    let intent = intent_pda(program_id, &intent_id);

    let ix = Instruction::new_with_bytes(
        *program_id,
        &bosphor_adapter::instruction::SubmitIntent {
            blob_id,
            size,
            encoding_type,
            storage_epochs,
            deadline,
        }
        .data(),
        bosphor_adapter::accounts::SubmitIntent {
            payer: payer.pubkey(),
            sender_nonce: nonce_pda(program_id, &payer.pubkey()),
            intent,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(svm, payer, &[payer], ix).expect("submit_intent should succeed");
    (intent_id, intent)
}

fn read_intent(svm: &LiteSVM, intent: &Pubkey) -> bosphor_adapter::state::IntentState {
    let acct = svm.get_account(intent).unwrap();
    let mut data: &[u8] = &acct.data;
    bosphor_adapter::state::IntentState::try_deserialize(&mut data).unwrap()
}

#[test]
fn happy_path_submit_then_execute() {
    let Some((mut svm, program_id, payer)) = setup() else {
        eprintln!("SKIP: bosphor_adapter.so not built; run `anchor build` first");
        return;
    };

    // Authority for the receive path is a dedicated keypair.
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 1_000_000_000).unwrap();
    initialize(&mut svm, &program_id, &payer, authority.pubkey());

    let blob_id = [0xABu8; 32];
    let (intent_id, intent) = submit_intent(
        &mut svm,
        &program_id,
        &payer,
        blob_id,
        1024,
        1,
        5,
        1_760_000_000,
        0,
    );

    let state = read_intent(&svm, &intent);
    assert_eq!(state.committed_blob_id, blob_id);
    assert_eq!(state.nonce, 0);
    assert!(!state.executed);
    assert_eq!(state.sender, payer.pubkey());

    // Nonce PDA should now read 1.
    let nonce_acct = svm.get_account(&nonce_pda(&program_id, &payer.pubkey())).unwrap();
    let mut nd: &[u8] = &nonce_acct.data;
    let sn = bosphor_adapter::state::SenderNonce::try_deserialize(&mut nd).unwrap();
    assert_eq!(sn.nonce, 1);

    // mark_executed with the matching blob id succeeds and flips the flag.
    let end_epoch = 42u64;
    let ix = Instruction::new_with_bytes(
        program_id,
        &bosphor_adapter::instruction::MarkExecuted {
            intent_id,
            returned_blob_id: blob_id,
            end_epoch,
        }
        .data(),
        bosphor_adapter::accounts::MarkExecuted {
            authority: authority.pubkey(),
            config: config_pda(&program_id),
            intent,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &authority, &[&authority], ix).expect("mark_executed should succeed");

    let state = read_intent(&svm, &intent);
    assert!(state.executed);
    assert_eq!(state.end_epoch, end_epoch);
}

#[test]
fn mark_executed_rejects_blob_id_mismatch() {
    let Some((mut svm, program_id, payer)) = setup() else {
        eprintln!("SKIP: bosphor_adapter.so not built; run `anchor build` first");
        return;
    };

    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 1_000_000_000).unwrap();
    initialize(&mut svm, &program_id, &payer, authority.pubkey());

    let blob_id = [0x11u8; 32];
    let (intent_id, intent) = submit_intent(
        &mut svm,
        &program_id,
        &payer,
        blob_id,
        1,
        0,
        1,
        1_760_000_000,
        0,
    );

    // A different returned blob id must be rejected with BlobIdMismatch.
    let wrong_blob = [0x22u8; 32];
    let ix = Instruction::new_with_bytes(
        program_id,
        &bosphor_adapter::instruction::MarkExecuted {
            intent_id,
            returned_blob_id: wrong_blob,
            end_epoch: 7,
        }
        .data(),
        bosphor_adapter::accounts::MarkExecuted {
            authority: authority.pubkey(),
            config: config_pda(&program_id),
            intent,
        }
        .to_account_metas(None),
    );
    let res = send(&mut svm, &authority, &[&authority], ix);
    assert!(res.is_err(), "mismatched blob id must be rejected");

    // Intent must remain unexecuted after the failed proof.
    let state = read_intent(&svm, &intent);
    assert!(!state.executed);
}

#[test]
fn mark_executed_rejects_wrong_authority() {
    let Some((mut svm, program_id, payer)) = setup() else {
        eprintln!("SKIP: bosphor_adapter.so not built; run `anchor build` first");
        return;
    };

    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 1_000_000_000).unwrap();
    initialize(&mut svm, &program_id, &payer, authority.pubkey());

    let blob_id = [0x33u8; 32];
    let (intent_id, intent) =
        submit_intent(&mut svm, &program_id, &payer, blob_id, 1, 0, 1, 1_760_000_000, 0);

    // A random signer that is not the config authority must be rejected.
    let imposter = Keypair::new();
    svm.airdrop(&imposter.pubkey(), 1_000_000_000).unwrap();
    let ix = Instruction::new_with_bytes(
        program_id,
        &bosphor_adapter::instruction::MarkExecuted {
            intent_id,
            returned_blob_id: blob_id,
            end_epoch: 7,
        }
        .data(),
        bosphor_adapter::accounts::MarkExecuted {
            authority: imposter.pubkey(),
            config: config_pda(&program_id),
            intent,
        }
        .to_account_metas(None),
    );
    let res = send(&mut svm, &imposter, &[&imposter], ix);
    assert!(res.is_err(), "non-authority signer must be rejected");
}
