import { Injectable, Logger } from '@nestjs/common';
import { Transaction } from '@mysten/sui/transactions';
import { ethers } from 'ethers';
import { SuiService } from './sui.service';
import { DEFAULT_LZ_OPTIONS } from '../../common/constants';

@Injectable()
export class SuiLzService {
  private readonly logger = new Logger(SuiLzService.name);

  constructor(private readonly sui: SuiService) {}

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

    const tx = new Transaction();

    const intentIdBytes = Array.from(ethers.getBytes(intentId));
    const blobIdBytes = Array.from(Buffer.from(blobId, 'base64url'));
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
    const { response } = await client.transactionExecutionService.simulateTransaction(
      {
        transaction: { bcs: { value: bytes } },
        // FieldMask paths are proto field names (snake_case). The repeated
        // command results only populate when the leaf path is requested
        // explicitly; the camelCase parent 'commandOutputs' returns an empty
        // array and the fee parse below fails, forcing the oversized fallback.
        readMask: { paths: ['command_outputs.return_values'] },
      },
    );

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

    const tx = new Transaction();

    const intentIdBytes = Array.from(ethers.getBytes(intentId));
    const blobIdBytes = Array.from(Buffer.from(blobId, 'base64url'));
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
