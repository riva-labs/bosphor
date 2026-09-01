// Reproduction and verification script for issue #337: lz_send_proof abort code 10
// in call::new_child_batch.
//
// Modes:
//   node repro-lz-send.mjs quote|send|both
//     Simulates the quote and/or send PTB against Sui testnet as the relayer
//     address. Read-only (simulateTransaction), no keys needed.
//   node repro-lz-send.mjs send-live <intentIdHex> <blobFieldHex> <endEpoch>
//     Quotes, then signs and executes the real send PTB for the given received
//     intent. Requires SUI_RELAYER_KEY or SUI_DEPLOYER_KEY in the environment
//     (load with BOSPHOR_ENV_FILE-style dotenv or node --env-file).
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const DST_EID = 40161;

const env = {
  lzPackageId: '0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5',
  lzConfigId: '0x880df43118caa95a934b1bca0b30d5dd76a8f41d4e1d3d74f071fcfefc6250fd',
  lzOappId: '0x621a3a05a2b317c859fd4cc46ce663e51299ec97187f34bfeb93ec258eace8f4',
  lzMessagingChannel: '0x383e51c09f5bc47ded87481d7a0b52066cb100316175cb489a4eb0bd44597c4a',
  endpointV2: '0xabf9629418d997fcc742a5ca22820241b72fb53691f010bc964eb49b4bd2263a',
  endpointV2Obj: '0x2b96537c30c5fa962a1bfb58a168fc17c17f2546c88e2e9252f21ee7d5eff57a',
  uln302: '0xf5d69c7b0922ce0ab4540525fbc66ca25ce9f092c64b032b91e4c5625ea0fb24',
  uln302Obj: '0x69541d4feeb08cdd3b20b3502021a676eea0fca4f47d46e423cdc9686df406ff',
  executorPkg: '0xb9fdc6748fb939095e249b22717d564edf890681e387131d6c525d867d30f834',
  executorObj: '0x51816836a18df1cc8bbc0ae840e01da8fef15968ddbb390f4d6b9243b7911f23',
  execFeeLib: '0xa99c7ca780a6cedfc27d9274c031741b68014886cba04dafe8335c72eeeed0b5',
  execFeeLibObj: '0x4e0c4cc4aa88b428005a8bb131014fdf9637a3ae042f192b9071119a64a32138',
  dvnPkg: '0xfa5a7bd745a56f3f18f4830563c8b65a737dcfca5b9e5aa281f2f2cd3f6eaf6d',
  dvnObj: '0x4160cd9281e79a93f87f7f45853cd682750102be01f36d1c33ef99ee8cd86e0d',
  dvnFeeLib: '0xfb596f2afcc4f15ec8660fb241c3a7bc9aa2f9b3b820914b6990202b5f236f2f',
  dvnFeeLibObj: '0xd433507170ea8cf08c5697128e80fca03f5c03c4a2f639bc632e6647baff63e1',
  priceFeed: '0xa4f8f126dc7e2a763676eab3a6f0a12afaf334baa0f37b41a1e93890cf95ea4c',
  priceFeedObj: '0xc8ae95cdc862a032e4d35f5f4c5dd6d3d07bdde2c7f39460e78e1539cc07dc2d',
  treasuryObj: '0x40a2b309bda42658dd12e967574f6e77170082599a77b158051c31064df82be1',
};

// Real received intent (nonce 73, src_eid 40161) from the on-chain table.
// Override with INTENT_ID / BLOB_FIELD / END_EPOCH env vars.
const intentIdBytes = process.env.INTENT_ID
  ? Array.from(Buffer.from(process.env.INTENT_ID.replace(/^0x/, ''), 'hex'))
  : Array.from(Buffer.from('Mfm5pPnyfL9Hvz+HJCkDkU1+v8rkZ6twMtsX4NwFI7c=', 'base64'));
const blobIdBig = 92146816957036505747295261031584160009764083153295142224227900204435745163847n;
const blobIdBytes = process.env.BLOB_FIELD
  ? Array.from(Buffer.from(process.env.BLOB_FIELD.replace(/^0x/, ''), 'hex'))
  : Array.from(Buffer.from(blobIdBig.toString(16).padStart(64, '0'), 'hex'));
let endEpoch = process.env.END_EPOCH ? Number(process.env.END_EPOCH) : 250;
// Type-3 options: executor lzReceive gas (mirrors DEFAULT_LZ_OPTIONS in the relayer)
const optionsBytes = Array.from(Buffer.from('00030100110100000000000000000000000000030d40', 'hex'));

const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });

// Simulate and send as the relayer the on-chain LzReceiverConfig actually
// authorizes. A hardcoded address here once masked the live abort 2
// (EUnauthorizedRelayer): the script pinned the deployer, which was authorized,
// while the deployed relayer signed with a different, unauthorized key.
async function readAuthorizedRelayer() {
  const { response } = await client.ledgerService.getObject({
    objectId: env.lzConfigId,
    readMask: { paths: ['json'] },
  });
  const field = response.object?.json?.kind?.structValue?.fields?.relayer;
  const relayer = field?.kind?.oneofKind === 'stringValue' ? field.kind.stringValue : undefined;
  if (!relayer) throw new Error(`Failed to read relayer from LzReceiverConfig ${env.lzConfigId}`);
  return relayer;
}
const RELAYER = await readAuthorizedRelayer();
console.log(`authorized relayer (on-chain): ${RELAYER}`);

function buildQuoteTx() {
  const tx = new Transaction();
  const [quoteCall] = tx.moveCall({
    target: `${env.lzPackageId}::lz_receiver::quote_proof`,
    arguments: [
      tx.object(env.lzConfigId), tx.object(env.lzOappId),
      tx.pure.vector('u8', intentIdBytes), tx.pure.vector('u8', blobIdBytes),
      tx.pure.u64(endEpoch), tx.pure.u32(DST_EID), tx.pure.vector('u8', optionsBytes),
    ],
  });
  const [msglibQuoteCall] = tx.moveCall({
    target: `${env.endpointV2}::endpoint_v2::quote`,
    arguments: [tx.object(env.endpointV2Obj), tx.object(env.lzMessagingChannel), quoteCall],
  });
  const [execGetFeeCall, dvnGetFeeMultiCall] = tx.moveCall({
    target: `${env.uln302}::uln_302::quote`,
    arguments: [tx.object(env.uln302Obj), msglibQuoteCall],
  });
  const [execFlCall] = tx.moveCall({
    target: `${env.executorPkg}::executor_worker::get_fee`,
    arguments: [tx.object(env.executorObj), execGetFeeCall],
  });
  const [execPfCall] = tx.moveCall({
    target: `${env.execFeeLib}::executor_fee_lib::get_fee`,
    arguments: [tx.object(env.execFeeLibObj), execFlCall],
  });
  tx.moveCall({
    target: `${env.priceFeed}::price_feed::estimate_fee_by_eid`,
    arguments: [tx.object(env.priceFeedObj), execPfCall],
  });
  tx.moveCall({
    target: `${env.execFeeLib}::executor_fee_lib::confirm_get_fee`,
    arguments: [tx.object(env.execFeeLibObj), execFlCall, execPfCall],
  });
  tx.moveCall({
    target: `${env.executorPkg}::executor_worker::confirm_get_fee`,
    arguments: [tx.object(env.executorObj), execGetFeeCall, execFlCall],
  });
  const [dvnFlCall] = tx.moveCall({
    target: `${env.dvnPkg}::dvn::get_fee`,
    arguments: [tx.object(env.dvnObj), dvnGetFeeMultiCall],
  });
  const [dvnPfCall] = tx.moveCall({
    target: `${env.dvnFeeLib}::dvn_fee_lib::get_fee`,
    arguments: [tx.object(env.dvnFeeLibObj), dvnFlCall],
  });
  tx.moveCall({
    target: `${env.priceFeed}::price_feed::estimate_fee_by_eid`,
    arguments: [tx.object(env.priceFeedObj), dvnPfCall],
  });
  tx.moveCall({
    target: `${env.dvnFeeLib}::dvn_fee_lib::confirm_get_fee`,
    arguments: [tx.object(env.dvnFeeLibObj), dvnFlCall, dvnPfCall],
  });
  tx.moveCall({
    target: `${env.dvnPkg}::dvn::confirm_get_fee`,
    arguments: [tx.object(env.dvnObj), dvnGetFeeMultiCall, dvnFlCall],
  });
  tx.moveCall({
    target: `${env.uln302}::uln_302::confirm_quote`,
    arguments: [
      tx.object(env.uln302Obj), tx.object(env.treasuryObj),
      msglibQuoteCall, execGetFeeCall, dvnGetFeeMultiCall,
    ],
  });
  tx.moveCall({
    target: `${env.endpointV2}::endpoint_v2::confirm_quote`,
    arguments: [tx.object(env.endpointV2Obj), quoteCall, msglibQuoteCall],
  });
  tx.moveCall({
    target: `${env.lzPackageId}::lz_receiver::confirm_quote_proof`,
    arguments: [tx.object(env.lzConfigId), tx.object(env.lzOappId), quoteCall],
  });
  return tx;
}

function buildSendTx(feeAmount) {
  const tx = new Transaction();
  const [feeCoin] = tx.splitCoins(tx.gas, [feeAmount]);
  const [call] = tx.moveCall({
    target: `${env.lzPackageId}::lz_receiver::lz_send_proof`,
    arguments: [
      tx.object(env.lzConfigId), tx.object(env.lzOappId),
      tx.pure.vector('u8', intentIdBytes), tx.pure.vector('u8', blobIdBytes),
      tx.pure.u64(endEpoch), tx.pure.u32(DST_EID), tx.pure.vector('u8', optionsBytes),
      feeCoin,
    ],
  });
  const [msglibCall] = tx.moveCall({
    target: `${env.endpointV2}::endpoint_v2::send`,
    arguments: [tx.object(env.endpointV2Obj), tx.object(env.lzMessagingChannel), call],
  });
  const [execCall, dvnMultiCall] = tx.moveCall({
    target: `${env.uln302}::uln_302::send`,
    arguments: [tx.object(env.uln302Obj), msglibCall],
  });
  const [execFlCall] = tx.moveCall({
    target: `${env.executorPkg}::executor_worker::assign_job`,
    arguments: [tx.object(env.executorObj), execCall],
  });
  const [execPfCall] = tx.moveCall({
    target: `${env.execFeeLib}::executor_fee_lib::get_fee`,
    arguments: [tx.object(env.execFeeLibObj), execFlCall],
  });
  tx.moveCall({
    target: `${env.priceFeed}::price_feed::estimate_fee_by_eid`,
    arguments: [tx.object(env.priceFeedObj), execPfCall],
  });
  tx.moveCall({
    target: `${env.execFeeLib}::executor_fee_lib::confirm_get_fee`,
    arguments: [tx.object(env.execFeeLibObj), execFlCall, execPfCall],
  });
  tx.moveCall({
    target: `${env.executorPkg}::executor_worker::confirm_assign_job`,
    arguments: [tx.object(env.executorObj), execCall, execFlCall],
  });
  const [dvnFlCall] = tx.moveCall({
    target: `${env.dvnPkg}::dvn::assign_job`,
    arguments: [tx.object(env.dvnObj), dvnMultiCall],
  });
  const [dvnPfCall] = tx.moveCall({
    target: `${env.dvnFeeLib}::dvn_fee_lib::get_fee`,
    arguments: [tx.object(env.dvnFeeLibObj), dvnFlCall],
  });
  tx.moveCall({
    target: `${env.priceFeed}::price_feed::estimate_fee_by_eid`,
    arguments: [tx.object(env.priceFeedObj), dvnPfCall],
  });
  tx.moveCall({
    target: `${env.dvnFeeLib}::dvn_fee_lib::confirm_get_fee`,
    arguments: [tx.object(env.dvnFeeLibObj), dvnFlCall, dvnPfCall],
  });
  tx.moveCall({
    target: `${env.dvnPkg}::dvn::confirm_assign_job`,
    arguments: [tx.object(env.dvnObj), dvnMultiCall, dvnFlCall],
  });
  tx.moveCall({
    target: `${env.uln302}::uln_302::confirm_send`,
    arguments: [
      tx.object(env.uln302Obj), tx.object(env.endpointV2Obj), tx.object(env.treasuryObj),
      tx.object(env.lzMessagingChannel), call, msglibCall, execCall, dvnMultiCall,
    ],
  });
  tx.moveCall({
    target: `${env.lzPackageId}::lz_receiver::confirm_lz_send_proof`,
    arguments: [tx.object(env.lzConfigId), tx.object(env.lzOappId), call],
  });
  return tx;
}

async function simulate(name, tx) {
  tx.setSender(RELAYER);
  try {
    const bytes = await tx.build({ client });
    const { response } = await client.transactionExecutionService.simulateTransaction({
      transaction: { bcs: { value: bytes } },
      readMask: { paths: ['transaction.effects.status', 'command_outputs.return_values'] },
    });
    const status = response.transaction?.effects?.status;
    console.log(`${name}: success=${status?.success}`);
    if (!status?.success) {
      console.log(`${name} error:`, JSON.stringify(status?.error, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
    } else if (name === 'quote') {
      const outputs = response.commandOutputs ?? [];
      const rv = outputs[outputs.length - 1]?.returnValues?.[0]?.value?.value;
      if (rv) console.log('quote fee (LE u64):', Buffer.from(rv).readBigUInt64LE(0).toString());
    }
    return response;
  } catch (e) {
    console.log(`${name} THREW: ${e.message}`);
    if (e.executionError) {
      console.log(`${name} executionError:`, JSON.stringify(e.executionError, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
    }
    return null;
  }
}

async function sendLive(intentIdHex, blobFieldHex, endEpochArg) {
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');
  const key = process.env.SUI_RELAYER_KEY || process.env.SUI_DEPLOYER_KEY;
  if (!key) throw new Error('send-live requires SUI_RELAYER_KEY or SUI_DEPLOYER_KEY');
  const { secretKey } = decodeSuiPrivateKey(key);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);
  if (signer.toSuiAddress() !== RELAYER) {
    throw new Error(
      `key resolves to ${signer.toSuiAddress()} but the LzReceiverConfig authorizes ${RELAYER}; ` +
        `run scripts/util/set-lz-relayer.ts to fix the on-chain relayer`,
    );
  }

  const ids = Array.from(Buffer.from(intentIdHex.replace(/^0x/, ''), 'hex'));
  const blob = Array.from(Buffer.from(blobFieldHex.replace(/^0x/, ''), 'hex'));
  const epoch = Number(endEpochArg);
  if (ids.length !== 32 || blob.length !== 32 || !Number.isFinite(epoch)) {
    throw new Error('usage: send-live <intentIdHex:32B> <blobFieldHex:32B> <endEpoch>');
  }

  // Override the module-level intent fixture with the live intent.
  intentIdBytes.length = 0;
  intentIdBytes.push(...ids);
  blobIdBytes.length = 0;
  blobIdBytes.push(...blob);
  endEpoch = epoch;

  const quoteResp = await simulate('quote', buildQuoteTx());
  const outputs = quoteResp?.commandOutputs ?? [];
  const rv = outputs[outputs.length - 1]?.returnValues?.[0]?.value?.value;
  if (!rv) throw new Error('quote simulation returned no fee');
  const fee = Buffer.from(rv).readBigUInt64LE(0);
  const feeWithBuffer = (fee * 11n) / 10n;
  console.log(`quoted fee ${fee} MIST, sending with ${feeWithBuffer}`);

  const tx = buildSendTx(feeWithBuffer);
  tx.setSender(RELAYER);
  const bytes = await tx.build({ client });
  const { signature } = await signer.signTransaction(bytes);
  const result = await client.core.executeTransaction({ transaction: bytes, signatures: [signature] });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`send failed: ${JSON.stringify(result.FailedTransaction?.status)}`);
  }
  const txn = result.Transaction ?? result.transaction;
  console.log(`send-live status: ${JSON.stringify(txn?.status ?? txn?.effects?.status)}`);
  console.log(`send-live digest: ${txn?.digest}`);
}

const mode = process.argv[2] ?? 'both';
if (mode === 'quote' || mode === 'both') await simulate('quote', buildQuoteTx());
if (mode === 'send' || mode === 'both') await simulate('send', buildSendTx(300_000_000n));
if (mode === 'send-live') await sendLive(process.argv[3], process.argv[4], process.argv[5]);
