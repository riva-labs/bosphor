/**
 * Shared Sui gRPC factory module.
 *
 * Centralizes SuiGrpcClient creation, signer setup, and transaction
 * execution so that scripts and the relayer share one set of helpers
 * instead of duplicating gRPC boilerplate.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

/**
 * Create a SuiGrpcClient. If no url is provided, reads SUI_GRPC_URL
 * from the environment (falls back to Sui testnet).
 */
export function createSuiClient(url?: string): SuiGrpcClient {
  const grpcUrl = url ?? process.env.SUI_GRPC_URL ?? "https://sui-testnet.mystenlabs.com";
  const network = grpcUrl.includes("mainnet") ? "mainnet" as const : "testnet" as const;
  return new SuiGrpcClient({ network, baseUrl: grpcUrl });
}

/**
 * Decode a Sui private key string and return an Ed25519Keypair.
 */
export function createSuiSigner(privateKey: string): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(privateKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

/**
 * Build, sign, and execute a transaction via gRPC.
 *
 * Uses core.executeTransaction which wraps the protobuf encoding
 * and returns a parsed TransactionResponse with digest and effects.
 */
export async function signAndExecute(
  client: SuiGrpcClient,
  tx: Transaction,
  signer: Ed25519Keypair,
) {
  // Mirrors the relayer's proven @mysten/sui v2 execution path. Requires the
  // v2 SuiGrpcClient (v1's gRPC build cannot resolve object versions).
  tx.setSender(signer.toSuiAddress());
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      // Rebuild each attempt so the gas coin / shared object versions are
      // re-resolved after the prior tx (cross-node read-after-write lag).
      const bytes = await tx.build({ client });
      const { signature } = await signer.signTransaction(bytes);
      const result: any = await client.core.executeTransaction({
        transaction: bytes,
        signatures: [signature],
      });
      if (result.$kind === "FailedTransaction") {
        throw new Error(`Sui tx failed: ${JSON.stringify(result.FailedTransaction.status)}`);
      }
      return result.Transaction;
    } catch (err) {
      lastErr = err;
      const msg = decodeURIComponent(String((err as any)?.message ?? err));
      const retriable = /unavailable for consumption|needs to be rebuilt|is not available|reserved for another|version/i.test(msg);
      if (attempt === 8 || !retriable) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

/**
 * Simulate a transaction with command_outputs in the readMask.
 *
 * Uses the raw transactionExecutionService.simulateTransaction since
 * core.dryRunTransaction omits command_outputs from its readMask.
 */
export async function simulateWithOutputs(
  client: SuiGrpcClient,
  tx: Transaction,
  sender: string,
) {
  tx.setSender(sender);
  const bytes = await tx.build({ client });
  const result = await client.transactionExecutionService.simulateTransaction(
    {
      transaction: { bcs: { value: bytes } },
      // FieldMask paths are proto field names (snake_case). The repeated
      // command results only populate when the leaf path is requested
      // explicitly; the camelCase parent "commandOutputs" returns empty.
      readMask: { paths: ["command_outputs.return_values"] },
    },
  );
  return result.response.commandOutputs ?? [];
}

/**
 * Read the CallCap identity of a LayerZero worker object (executor or DVN).
 *
 * Workers authenticate against the Call objects the ULN creates for them via
 * their CallCap: a Package cap identifies as the worker's original package
 * address, an Individual cap as the cap object's own id. ULN configs must
 * reference this identity, never the worker's latest package id or object id.
 */
export async function getWorkerCapAddress(
  client: SuiGrpcClient,
  objectId: string,
): Promise<string> {
  const { response } = await client.ledgerService.getObject({
    objectId,
    readMask: { paths: ["json"] },
  });
  type ProtoValue = {
    kind?: {
      oneofKind?: string;
      stringValue?: string;
      structValue?: { fields?: Record<string, ProtoValue> };
    };
  };
  const field = (node: ProtoValue | undefined, ...path: string[]): ProtoValue | undefined => {
    for (const key of path) {
      if (node?.kind?.oneofKind !== "structValue") return undefined;
      node = node.kind.structValue?.fields?.[key];
    }
    return node;
  };
  const str = (node: ProtoValue | undefined): string | undefined =>
    node?.kind?.oneofKind === "stringValue" ? node.kind.stringValue : undefined;

  const json = response.object?.json as ProtoValue | undefined;
  const capType = str(field(json, "worker", "worker_cap", "cap_type", "@variant"));
  const capAddress =
    capType === "Package"
      ? str(field(json, "worker", "worker_cap", "cap_type", "pos0"))
      : str(field(json, "worker", "worker_cap", "id"));
  if (!capAddress) {
    throw new Error(`Failed to read the worker CallCap identity of object ${objectId}`);
  }
  return capAddress;
}
