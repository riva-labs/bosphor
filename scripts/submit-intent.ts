import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve("/home/arb/bosphor/.env") });
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL!, undefined, { staticNetwork: true });
const wallet = new ethers.Wallet(process.env.EVM_RELAYER_KEY!, provider);

const ADAPTER_ABI = [
  "function submitIntent(uint32 dstEid, bytes payload, uint256 deadline, bytes options) payable returns (bytes32)",
  "function quote(uint32 dstEid, bytes payload, uint256 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function nonces(address) view returns (uint256)",
];

const adapter = new ethers.Contract(process.env.EVM_ADAPTER_ADDRESS!, ADAPTER_ABI, wallet);

async function main() {
  const payload = ethers.toUtf8Bytes(`bosphor-mainnet-${Date.now()}`);
  const deadline = Math.floor(Date.now() / 1000) + 14400;
  const DST_EID = 30378;
  const LZ_OPTIONS = "0x00030100110100000000000000000000000000030d40";

  console.log("Nonce:", (await adapter.nonces(wallet.address)).toString());
  console.log("Deadline:", deadline);
  
  const fee = await adapter.quote(DST_EID, payload, deadline, LZ_OPTIONS);
  console.log("Fee:", fee.nativeFee.toString(), "wei =", ethers.formatEther(fee.nativeFee), "ETH");

  console.log("Submitting...");
  const tx = await adapter.submitIntent(DST_EID, payload, deadline, LZ_OPTIONS, { value: fee.nativeFee });
  console.log("TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("Status:", receipt!.status === 1 ? "SUCCESS" : "REVERTED");
  console.log("Block:", receipt!.blockNumber);
  console.log("Logs:", receipt!.logs.length);
  console.log("");
  console.log("Etherscan: https://etherscan.io/tx/" + tx.hash);
  console.log("LZ Scan:   https://layerzeroscan.com/tx/" + tx.hash);
}

main().catch(err => { console.error("Error:", err.message || err); process.exit(1); });
