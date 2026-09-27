import { FORWARD_MESSAGE_LEN, quoteSolanaLzFeeLamports, SolanaLzFeePath } from './solana-lz-fee';

const ADMIN = 'Admin1111111111111111111111111111111111111';
const ENDPOINT = '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6';

const PATH: SolanaLzFeePath = {
  programId: '7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF',
  endpointProgram: ENDPOINT,
  ulnProgram: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH',
  dstEid: 40378,
  receiver: '0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5',
  options: '0x00030100110100000000000000000000000000030d40',
};

class FakeKey {
  constructor(readonly key: string) {}
  toBase58() {
    return this.key;
  }
  toBytes() {
    return new Uint8Array(32).fill(7);
  }
}

/** Fakes of the web3.js / LZ SDK / Connection surfaces the quote touches. */
function fakes(opts: {
  returnData?: { programId: string; data: [string, string] } | null;
  simErr?: unknown;
  store?: boolean;
}) {
  const seen: { payer?: string; params?: Record<string, unknown>; keys?: number } = {};
  const PublicKey = Object.assign(
    class extends FakeKey {
      constructor(k: string | Uint8Array) {
        super(typeof k === 'string' ? k : ADMIN);
      }
    },
    { findProgramAddressSync: () => [new FakeKey('StorePda'), 255] },
  );
  const web3 = {
    PublicKey,
    TransactionInstruction: class {
      constructor(o: { keys: unknown[] }) {
        seen.keys = o.keys.length;
      }
    },
    TransactionMessage: class {
      constructor(o: { payerKey: FakeKey }) {
        seen.payer = o.payerKey.toBase58();
      }
      compileToV0Message() {
        return {};
      }
    },
    VersionedTransaction: class {},
  };
  const lz = {
    EndpointProgram: {
      Endpoint: class {
        async getQuoteIXAccountMetaForCPI() {
          return [
            { pubkey: new FakeKey(ENDPOINT), isSigner: false, isWritable: false },
            { pubkey: new FakeKey('A'), isSigner: false, isWritable: false },
            { pubkey: new FakeKey('B'), isSigner: false, isWritable: true },
          ];
        }
      },
      instructions: {
        quoteInstructionDiscriminator: [1, 2, 3, 4, 5, 6, 7, 8],
        quoteStruct: {
          serialize(args: { params: Record<string, unknown> }) {
            seen.params = args.params;
            return [new Uint8Array(8)];
          },
        },
      },
    },
    UlnProgram: { Uln: class {} },
  };
  const connection = {
    getAccountInfo: async () => (opts.store === false ? null : { data: new Uint8Array(80) }),
    getLatestBlockhash: async () => ({ blockhash: 'hash' }),
    simulateTransaction: async () => ({
      value: {
        err: opts.simErr ?? null,
        logs: ['log a', 'log b'],
        returnData: opts.returnData === undefined ? null : opts.returnData,
      },
    }),
  };
  return { deps: { connection, web3, lz }, seen };
}

/** base64 of MessagingFee { native_fee, lz_token_fee } little-endian. */
function feeB64(native: bigint): string {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(native, 0);
  return b.toString('base64');
}

describe('quoteSolanaLzFeeLamports', () => {
  it('simulates the endpoint quote and decodes the native fee', async () => {
    const { deps, seen } = fakes({
      returnData: { programId: ENDPOINT, data: [feeB64(5_911_260n), 'base64'] },
    });
    await expect(quoteSolanaLzFeeLamports(deps, PATH)).resolves.toBe(5_911_260n);
    expect(seen.payer).toBe(ADMIN);
    expect(seen.keys).toBe(2);
    expect((seen.params!.message as Uint8Array).length).toBe(FORWARD_MESSAGE_LEN);
    expect(seen.params!.dstEid).toBe(40378);
    expect((seen.params!.receiver as number[]).length).toBe(32);
  });

  it('throws when the simulation fails, never returning a made up fee', async () => {
    const { deps } = fakes({ simErr: { InstructionError: [0, 'Custom'] } });
    await expect(quoteSolanaLzFeeLamports(deps, PATH)).rejects.toThrow(
      /simulation failed.*InstructionError.*log b/,
    );
  });

  it('throws when the return data is missing or from another program', async () => {
    await expect(quoteSolanaLzFeeLamports(fakes({ returnData: null }).deps, PATH)).rejects.toThrow(
      /no return data/,
    );
    const foreign = fakes({ returnData: { programId: 'Other', data: [feeB64(1n), 'base64'] } });
    await expect(quoteSolanaLzFeeLamports(foreign.deps, PATH)).rejects.toThrow(/simulation failed/);
  });

  it('throws when the Bosphor Store account does not exist on the cluster', async () => {
    await expect(quoteSolanaLzFeeLamports(fakes({ store: false }).deps, PATH)).rejects.toThrow(
      /Store account .* not found/,
    );
  });
});
