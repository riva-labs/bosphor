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
  const bytes = await tx.build({ client });
  const { signature } = await signer.signTransaction(bytes);
  return client.core.executeTransaction({
    transaction: bytes,
    signatures: [signature],
  });
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
      readMask: { paths: ["commandOutputs"] },
    },
  );
  return result.response.commandOutputs ?? [];
}
