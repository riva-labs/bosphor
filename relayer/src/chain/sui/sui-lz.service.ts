import { Injectable, Logger } from '@nestjs/common';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { ethers } from 'ethers';
import { SuiService } from './sui.service';
import { DEFAULT_LZ_OPTIONS } from '../../common/constants';
import { walrusBlobIdToField } from '../../common/walrus-blob-id';

/** BCS layout of uln_302 ExecutorConfig (see LayerZero-v2 sui contracts). */
export const ExecutorConfigBcs = bcs.struct('ExecutorConfig', {
  max_message_size: bcs.u64(),
  executor: bcs.Address,
});

/** BCS layout of uln_302 UlnConfig (see LayerZero-v2 sui contracts). */
export const UlnConfigBcs = bcs.struct('UlnConfig', {
  confirmations: bcs.u64(),
  required_dvns: bcs.vector(bcs.Address),
  optional_dvns: bcs.vector(bcs.Address),
  optional_dvn_threshold: bcs.u8(),
});

/**
 * Minimal shape of the protobuf JSON encoding returned by the gRPC
 * ledgerService for Move object contents.
 */
interface ProtoValue {
  kind?: {
    oneofKind?: string;
    stringValue?: string;
    structValue?: { fields?: Record<string, ProtoValue> };
  };
}

/** Read a nested struct field from the proto JSON encoding of a Move object. */
function protoField(value: ProtoValue | undefined, ...path: string[]): ProtoValue | undefined {
  let node = value;
  for (const key of path) {
    if (node?.kind?.oneofKind !== 'structValue') return undefined;
    node = node.kind.structValue?.fields?.[key];
  }
  return node;
}

/** Read a string leaf from the proto JSON encoding of a Move object. */
function protoString(value: ProtoValue | undefined, ...path: string[]): string | undefined {
  const node = protoField(value, ...path);
  return node?.kind?.oneofKind === 'stringValue' ? node.kind.stringValue : undefined;
}

/** Normalize a Sui address to lowercase 0x + 64 hex chars for comparison. */
function normalizeAddress(addr: string): string {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

@Injectable()
export class SuiLzService {
  private readonly logger = new Logger(SuiLzService.name);

  /** Destination eids whose send-path worker config already passed validation. */
  private readonly validatedDstEids = new Set<number>();

  constructor(private readonly sui: SuiService) {}

  /**
   * Read the CallCap identity of a worker object (executor or DVN).
   *
   * LayerZero workers authenticate against the `Call` objects the ULN creates
   * for them via their CallCap: a Package cap identifies as the worker's
   * original package address, an Individual cap as the cap object's own id.
   */
  private async getWorkerCapAddress(objectId: string, label: string): Promise<string> {
    const client = this.sui.getClient();
    const { response } = await client.ledgerService.getObject({
      objectId,
      readMask: { paths: ['json'] },
    });
    const json = response.object?.json as ProtoValue | undefined;
    const capType = protoString(json, 'worker', 'worker_cap', 'cap_type', '@variant');
    const capAddress =
      capType === 'Package'
        ? protoString(json, 'worker', 'worker_cap', 'cap_type', 'pos0')
        : protoString(json, 'worker', 'worker_cap', 'id');
    if (!capAddress) {
      throw new Error(`Failed to read the CallCap identity of ${label} object ${objectId}`);
    }
    return normalizeAddress(capAddress);
  }

  /**
   * Verify that the effective on-chain send config for our OApp pathway
   * matches the worker objects this service wires into the quote/send PTBs.
   *
   * The ULN records each configured worker address as the callee of the child
   * call it creates. If a config entry holds any other address (for example a
   * worker package id instead of the worker's CallCap identity, the root cause
   * of issue #337), every quote/send aborts inside call::new_child_batch with
   * the opaque abort code 10 (EUnauthorized). This preflight turns that into
   * an actionable error naming the exact mismatch. The result is cached per
   * destination eid for the lifetime of the process.
   */
  private async assertSendPathConfig(dstEid: number): Promise<void> {
    if (this.validatedDstEids.has(dstEid)) return;

    const infra = this.sui.getLzInfra();
    const client = this.sui.getClient();

    // The ULN keys OApp configs by the packet sender: the OApp's CallCap
    // identity, recorded in the messaging channel at registration.
    const channel = await client.ledgerService.getObject({
      objectId: this.sui.getLzMessagingChannel(),
      readMask: { paths: ['json'] },
    });
    const sender = protoString(channel.response.object?.json as ProtoValue, 'oapp');
    if (!sender) {
      throw new Error('Failed to read the OApp sender from the LZ messaging channel');
    }

    // Effective (OApp merged with default) send-side configs, straight from
    // the ULN via a read-only simulation.
    const tx = new Transaction();
    tx.moveCall({
      target: `${infra.uln302}::uln_302::get_effective_executor_config`,
      arguments: [tx.object(infra.uln302Obj), tx.pure.address(sender), tx.pure.u32(dstEid)],
    });
    tx.moveCall({
      target: `${infra.uln302}::uln_302::get_effective_send_uln_config`,
      arguments: [tx.object(infra.uln302Obj), tx.pure.address(sender), tx.pure.u32(dstEid)],
    });
    tx.setSender(this.sui.getAddress());
    const bytes = await tx.build({ client });
    const { response } = await client.transactionExecutionService.simulateTransaction({
      transaction: { bcs: { value: bytes } },
      readMask: { paths: ['command_outputs.return_values'] },
    });
    const outputs = response.commandOutputs ?? [];
    const execConfigBytes = outputs[0]?.returnValues?.[0]?.value?.value;
    const ulnConfigBytes = outputs[1]?.returnValues?.[0]?.value?.value;
    if (!execConfigBytes || !ulnConfigBytes) {
      throw new Error(`Failed to read the effective LZ send config for dstEid ${dstEid}`);
    }
    const execConfig = ExecutorConfigBcs.parse(Uint8Array.from(execConfigBytes));
    const ulnConfig = UlnConfigBcs.parse(Uint8Array.from(ulnConfigBytes));

    // The worker identities the config must reference for our PTB to resolve.
    const executorCap = await this.getWorkerCapAddress(infra.executorObj, 'executor');
    const dvnCap = await this.getWorkerCapAddress(infra.dvnObj, 'DVN');

    const configuredExecutor = normalizeAddress(execConfig.executor);
    if (configuredExecutor !== executorCap) {
      throw new Error(
        `LZ send config mismatch for dstEid ${dstEid}: effective executor config points at ` +
          `${configuredExecutor} but the configured executor object ${infra.executorObj} ` +
          `identifies as ${executorCap}. The OApp executor config was likely set to a ` +
          `package id instead of the worker CallCap identity. Repair it with ` +
          `scripts/util/set-executor-config.ts (issue #337).`,
      );
    }

    const requiredDvns = ulnConfig.required_dvns.map(normalizeAddress);
    if (requiredDvns.length !== 1 || ulnConfig.optional_dvns.length !== 0) {
      throw new Error(
        `LZ send config mismatch for dstEid ${dstEid}: the send PTB wires exactly one DVN ` +
          `but the effective ULN config requires [${requiredDvns.join(', ')}] with ` +
          `${ulnConfig.optional_dvns.length} optional DVN(s)`,
      );
    }
    if (requiredDvns[0] !== dvnCap) {
      throw new Error(
        `LZ send config mismatch for dstEid ${dstEid}: effective ULN config requires DVN ` +
          `${requiredDvns[0]} but the configured DVN object ${infra.dvnObj} identifies as ${dvnCap}`,
      );
    }

    this.validatedDstEids.add(dstEid);
    this.logger.log(
      `LZ send path config validated for dstEid ${dstEid} ` +
        `(executor ${executorCap}, DVN ${dvnCap})`,
    );
  }

  /**
   * Quote the LZ messaging fee for sending a proof back to EVM.
   *
   * Builds a 16-step quote PTB (mirrors the send PTB but with quote functions),
   * runs it via simulateTransaction with command_outputs readMask,
   * and parses the MessagingFee BCS return.
   */
  async quoteLzFee(
    intentId: string,
    blobId: string,
    endEpoch: number,
    dstEid: number,
  ): Promise<bigint> {
    const lzConfigId = this.sui.getLzConfigId();
    const lzOappId = this.sui.getLzOappId();
    const lzMessagingChannel = this.sui.getLzMessagingChannel();
    const lzPackageId = this.sui.getLzPackageId();
    const infra = this.sui.getLzInfra();

    if (!lzConfigId || !lzOappId || !lzMessagingChannel) {
      throw new Error(
        'LZ quote requires SUI_LZ_CONFIG_ID, SUI_LZ_OAPP_ID, and SUI_LZ_MESSAGING_CHANNEL',
      );
    }
    if (!infra.endpointV2 || !infra.uln302Obj) {
      throw new Error('LZ infrastructure not configured. Set all SUI_LZ_* env vars.');
    }

    // Fail with an actionable error (instead of an opaque call::new_child_batch
    // abort) when the on-chain send config does not match our worker objects.
    await this.assertSendPathConfig(dstEid);

    const tx = new Transaction();

    const intentIdBytes = Array.from(ethers.getBytes(intentId));
    // Canonical big-endian blob-id field, so the returned proof matches the EVM
    // adapter's committedBlobId (see common/walrus-blob-id).
    const blobIdBytes = Array.from(walrusBlobIdToField(blobId));
    const optionsBytes = Array.from(ethers.getBytes(DEFAULT_LZ_OPTIONS));

    // [0] APP::quote_proof (no fee coin needed)
    const [quoteCall] = tx.moveCall({
      target: `${lzPackageId}::lz_receiver::quote_proof`,
      arguments: [
        tx.object(lzConfigId),
        tx.object(lzOappId),
        tx.pure.vector('u8', intentIdBytes),
        tx.pure.vector('u8', blobIdBytes),
        tx.pure.u64(endEpoch),
        tx.pure.u32(dstEid),
        tx.pure.vector('u8', optionsBytes),
      ],
    });

    // [1] endpoint_v2::quote
    const [msglibQuoteCall] = tx.moveCall({
      target: `${infra.endpointV2}::endpoint_v2::quote`,
      arguments: [tx.object(infra.endpointV2Obj), tx.object(lzMessagingChannel), quoteCall],
    });

    // [2] uln_302::quote
    const [execGetFeeCall, dvnGetFeeMultiCall] = tx.moveCall({
      target: `${infra.uln302}::uln_302::quote`,
      arguments: [tx.object(infra.uln302Obj), msglibQuoteCall],
    });

    // [3] executor_worker::get_fee
    const [execFlCall] = tx.moveCall({
      target: `${infra.executorPkg}::executor_worker::get_fee`,
      arguments: [tx.object(infra.executorObj), execGetFeeCall],
    });

    // [4] exec_fee_lib::get_fee
    const [execPfCall] = tx.moveCall({
      target: `${infra.execFeeLib}::executor_fee_lib::get_fee`,
      arguments: [tx.object(infra.execFeeLibObj), execFlCall],
    });

    // [5] price_feed::estimate_fee_by_eid (executor)
    tx.moveCall({
      target: `${infra.priceFeed}::price_feed::estimate_fee_by_eid`,
      arguments: [tx.object(infra.priceFeedObj), execPfCall],
    });

    // [6] exec_fee_lib::confirm_get_fee
    tx.moveCall({
      target: `${infra.execFeeLib}::executor_fee_lib::confirm_get_fee`,
      arguments: [tx.object(infra.execFeeLibObj), execFlCall, execPfCall],
    });

    // [7] executor_worker::confirm_get_fee
    tx.moveCall({
      target: `${infra.executorPkg}::executor_worker::confirm_get_fee`,
      arguments: [tx.object(infra.executorObj), execGetFeeCall, execFlCall],
    });

    // [8] dvn::get_fee
    const [dvnFlCall] = tx.moveCall({
      target: `${infra.dvnPkg}::dvn::get_fee`,
      arguments: [tx.object(infra.dvnObj), dvnGetFeeMultiCall],
    });

    // [9] dvn_fee_lib::get_fee
    const [dvnPfCall] = tx.moveCall({
      target: `${infra.dvnFeeLib}::dvn_fee_lib::get_fee`,
      arguments: [tx.object(infra.dvnFeeLibObj), dvnFlCall],
    });

    // [10] price_feed::estimate_fee_by_eid (dvn)
    tx.moveCall({
      target: `${infra.priceFeed}::price_feed::estimate_fee_by_eid`,
      arguments: [tx.object(infra.priceFeedObj), dvnPfCall],
    });

    // [11] dvn_fee_lib::confirm_get_fee
    tx.moveCall({
      target: `${infra.dvnFeeLib}::dvn_fee_lib::confirm_get_fee`,
      arguments: [tx.object(infra.dvnFeeLibObj), dvnFlCall, dvnPfCall],
    });

    // [12] dvn::confirm_get_fee
    tx.moveCall({
      target: `${infra.dvnPkg}::dvn::confirm_get_fee`,
      arguments: [tx.object(infra.dvnObj), dvnGetFeeMultiCall, dvnFlCall],
    });

    // [13] uln_302::confirm_quote
    tx.moveCall({
      target: `${infra.uln302}::uln_302::confirm_quote`,
      arguments: [
        tx.object(infra.uln302Obj),
        tx.object(infra.treasuryObj),
        msglibQuoteCall,
        execGetFeeCall,
        dvnGetFeeMultiCall,
      ],
    });

    // [14] endpoint_v2::confirm_quote
    tx.moveCall({
      target: `${infra.endpointV2}::endpoint_v2::confirm_quote`,
      arguments: [tx.object(infra.endpointV2Obj), quoteCall, msglibQuoteCall],
    });

    // [15] APP::confirm_quote_proof -> returns MessagingFee
    tx.moveCall({
      target: `${lzPackageId}::lz_receiver::confirm_quote_proof`,
      arguments: [tx.object(lzConfigId), tx.object(lzOappId), quoteCall],
    });

    const client = this.sui.getClient();
    tx.setSender(this.sui.getAddress());
    const bytes = await tx.build({ client });
    const { response } = await client.transactionExecutionService.simulateTransaction({
      transaction: { bcs: { value: bytes } },
      // FieldMask paths are proto field names (snake_case). The repeated
      // command results only populate when the leaf path is requested
      // explicitly; the camelCase parent 'commandOutputs' returns an empty
      // array and the fee parse below fails, forcing the oversized fallback.
      readMask: { paths: ['command_outputs.return_values'] },
    });

    const outputs = response.commandOutputs ?? [];
    const lastOutput = outputs[outputs.length - 1];
    const returnValue = lastOutput?.returnValues?.[0]?.value?.value;
    if (!returnValue || returnValue.length < 16) {
      throw new Error('Failed to parse LZ fee quote: no return value');
    }

    const buf = Buffer.from(returnValue);
    const nativeFee = buf.readBigUInt64LE(0);
    // A zero fee means the quote did not resolve to a real amount; sending with
    // a 0 fee coin would revert on-chain. Fail loudly instead of underpaying.
    if (nativeFee <= 0n) {
      throw new Error('Failed to parse LZ fee quote: non-positive native fee');
    }
    return nativeFee;
  }

  /**
   * Build and execute the 16-step LZ send PTB to send a proof back to EVM.
   */
  async lzSendProof(
    intentId: string,
    blobId: string,
    endEpoch: number,
    dstEid: number,
    feeAmount: bigint,
  ): Promise<string> {
    const lzConfigId = this.sui.getLzConfigId();
    const lzOappId = this.sui.getLzOappId();
    const lzMessagingChannel = this.sui.getLzMessagingChannel();
    const lzPackageId = this.sui.getLzPackageId();
    const infra = this.sui.getLzInfra();

    if (!lzConfigId || !lzOappId || !lzMessagingChannel) {
      throw new Error(
        'LZ send proof requires SUI_LZ_CONFIG_ID, SUI_LZ_OAPP_ID, and SUI_LZ_MESSAGING_CHANNEL',
      );
    }
    if (!infra.endpointV2 || !infra.uln302Obj) {
      throw new Error('LZ infrastructure not configured. Set all SUI_LZ_* env vars.');
    }

    // No-op when the quote already validated this eid in this process; guards
    // direct send calls that did not go through quoteLzFee first.
    await this.assertSendPathConfig(dstEid);

    const tx = new Transaction();

    const intentIdBytes = Array.from(ethers.getBytes(intentId));
    // Canonical big-endian blob-id field, so the returned proof matches the EVM
    // adapter's committedBlobId (see common/walrus-blob-id).
    const blobIdBytes = Array.from(walrusBlobIdToField(blobId));
    const optionsBytes = Array.from(ethers.getBytes(DEFAULT_LZ_OPTIONS));

    // [0] SplitCoins
    const [feeCoin] = tx.splitCoins(tx.gas, [feeAmount]);

    // [1] APP::lz_send_proof
    const [call] = tx.moveCall({
      target: `${lzPackageId}::lz_receiver::lz_send_proof`,
      arguments: [
        tx.object(lzConfigId),
        tx.object(lzOappId),
        tx.pure.vector('u8', intentIdBytes),
        tx.pure.vector('u8', blobIdBytes),
        tx.pure.u64(endEpoch),
        tx.pure.u32(dstEid),
        tx.pure.vector('u8', optionsBytes),
        feeCoin,
      ],
    });

    // [2] endpoint_v2::send
    const [msglibCall] = tx.moveCall({
      target: `${infra.endpointV2}::endpoint_v2::send`,
      arguments: [tx.object(infra.endpointV2Obj), tx.object(lzMessagingChannel), call],
    });

    // [3] uln_302::send
    const [execCall, dvnMultiCall] = tx.moveCall({
      target: `${infra.uln302}::uln_302::send`,
      arguments: [tx.object(infra.uln302Obj), msglibCall],
    });

    // [4] executor::assign_job
    const [execFlCall] = tx.moveCall({
      target: `${infra.executorPkg}::executor_worker::assign_job`,
      arguments: [tx.object(infra.executorObj), execCall],
    });

    // [5] exec_fee_lib::get_fee
    const [execPfCall] = tx.moveCall({
      target: `${infra.execFeeLib}::executor_fee_lib::get_fee`,
      arguments: [tx.object(infra.execFeeLibObj), execFlCall],
    });

    // [6] price_feed::estimate_fee_by_eid (executor)
    tx.moveCall({
      target: `${infra.priceFeed}::price_feed::estimate_fee_by_eid`,
      arguments: [tx.object(infra.priceFeedObj), execPfCall],
    });

    // [7] exec_fee_lib::confirm_get_fee
    tx.moveCall({
      target: `${infra.execFeeLib}::executor_fee_lib::confirm_get_fee`,
      arguments: [tx.object(infra.execFeeLibObj), execFlCall, execPfCall],
    });

    // [8] executor::confirm_assign_job
    tx.moveCall({
      target: `${infra.executorPkg}::executor_worker::confirm_assign_job`,
      arguments: [tx.object(infra.executorObj), execCall, execFlCall],
    });

    // [9] dvn::assign_job
    const [dvnFlCall] = tx.moveCall({
      target: `${infra.dvnPkg}::dvn::assign_job`,
      arguments: [tx.object(infra.dvnObj), dvnMultiCall],
    });

    // [10] dvn_fee_lib::get_fee
    const [dvnPfCall] = tx.moveCall({
      target: `${infra.dvnFeeLib}::dvn_fee_lib::get_fee`,
      arguments: [tx.object(infra.dvnFeeLibObj), dvnFlCall],
    });

    // [11] price_feed::estimate_fee_by_eid (dvn)
    tx.moveCall({
      target: `${infra.priceFeed}::price_feed::estimate_fee_by_eid`,
      arguments: [tx.object(infra.priceFeedObj), dvnPfCall],
    });

    // [12] dvn_fee_lib::confirm_get_fee
    tx.moveCall({
      target: `${infra.dvnFeeLib}::dvn_fee_lib::confirm_get_fee`,
      arguments: [tx.object(infra.dvnFeeLibObj), dvnFlCall, dvnPfCall],
    });

    // [13] dvn::confirm_assign_job
    tx.moveCall({
      target: `${infra.dvnPkg}::dvn::confirm_assign_job`,
      arguments: [tx.object(infra.dvnObj), dvnMultiCall, dvnFlCall],
    });

    // [14] uln_302::confirm_send
    tx.moveCall({
      target: `${infra.uln302}::uln_302::confirm_send`,
      arguments: [
        tx.object(infra.uln302Obj),
        tx.object(infra.endpointV2Obj),
        tx.object(infra.treasuryObj),
        tx.object(lzMessagingChannel),
        call,
        msglibCall,
        execCall,
        dvnMultiCall,
      ],
    });

    // [15] APP::confirm_lz_send_proof
    tx.moveCall({
      target: `${lzPackageId}::lz_receiver::confirm_lz_send_proof`,
      arguments: [tx.object(lzConfigId), tx.object(lzOappId), call],
    });

    const { digest, status } = await this.sui.signAndExecute(tx);

    if (!status.success) {
      throw new Error(`Sui tx failed: ${JSON.stringify(status)}`);
    }

    this.logger.log(`[${intentId}] LZ send proof tx: ${digest}`);
    return digest;
  }
}
