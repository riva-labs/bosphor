/**
 * Walrus drift check. Fails loudly when Walrus has upgraded its on-chain package
 * past the version the Sui executor links.
 *
 * Why: on 2026-10-19 Walrus testnet upgraded its System to v4 while our executor
 * still linked the old package, so every execute_store aborted (MoveAbort code 1
 * in system::inner) until the executor was relinked by hand (#486). This check
 * turns the next upgrade into a red CI run instead of a store outage.
 *
 * How: the executor's Move.lock pins MystenLabs/walrus by commit. At that commit
 * the upstream Published.toml names the package we link (original-id +
 * published-at). Sui GraphQL `packageVersions` returns what the chain runs now.
 *
 * Usage:
 *   npx tsx scripts/util/walrus-drift.ts            # testnet
 *   NETWORK=mainnet npx tsx scripts/util/walrus-drift.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type WalrusEnv = "testnet" | "mainnet";

export interface WalrusPin {
  subdir: string;
  rev: string;
}

export interface PublishedPackage {
  originalId: string;
  publishedAt: string;
  version: number;
}

export interface ChainPackage {
  address: string;
  version: number;
}

const GRAPHQL: Record<WalrusEnv, string> = {
  testnet: "https://graphql.testnet.sui.io/graphql",
  mainnet: "https://graphql.mainnet.sui.io/graphql",
};

/** The pinned walrus git source for one environment, from the executor Move.lock. */
export function walrusPin(lockText: string, env: WalrusEnv): WalrusPin {
  const section = lockText.split(/^(?=\[)/m).find((s) => s.startsWith(`[pinned.${env}.walrus]`));
  const m = section?.match(/subdir = "([^"]+)", rev = "([0-9a-f]{40})"/);
  if (!m) throw new Error(`no walrus pin for ${env} in the executor Move.lock`);
  return { subdir: m[1]!, rev: m[2]! };
}

/** original-id, published-at and version for one environment of a Published.toml. */
export function parsePublished(toml: string, env: WalrusEnv): PublishedPackage {
  const section = toml.split(/^(?=\[)/m).find((s) => s.startsWith(`[published.${env}]`));
  if (!section) throw new Error(`no [published.${env}] in Published.toml`);
  const field = (k: string) => section.match(new RegExp(`^${k} = "?([^"\\n]+)"?$`, "m"))?.[1];
  const originalId = field("original-id");
  const publishedAt = field("published-at");
  const version = Number(field("version"));
  if (!originalId || !publishedAt || !Number.isInteger(version)) {
    throw new Error(`incomplete [published.${env}] in Published.toml`);
  }
  return { originalId, publishedAt, version };
}

/** Normalize a Sui address for comparison: lowercase, no leading zeros. */
function normalize(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
}

/** Whether the chain still runs the Walrus package we link. */
export function driftVerdict(
  linked: PublishedPackage,
  latest: ChainPackage,
): { ok: boolean; message: string } {
  if (normalize(latest.address) === normalize(linked.publishedAt)) {
    return { ok: true, message: `Walrus v${linked.version} (${linked.publishedAt}) is still current` };
  }
  return {
    ok: false,
    message:
      `Walrus upgraded: the chain runs v${latest.version} (${latest.address}) but the executor ` +
      `links v${linked.version} (${linked.publishedAt}). Bump the walrus rev in ` +
      `contracts/sui/executor/Move.toml and relink the executor before stores start aborting.`,
  };
}

async function latestPackage(env: WalrusEnv, originalId: string): Promise<ChainPackage> {
  const res = await fetch(GRAPHQL[env], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query:
        "query ($a: SuiAddress!) { packageVersions(address: $a, last: 1) { nodes { address version } } }",
      variables: { a: originalId },
    }),
  });
  if (!res.ok) throw new Error(`sui graphql ${res.status} ${res.statusText}`);
  const body = (await res.json()) as {
    data?: { packageVersions?: { nodes: ChainPackage[] } | null };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(`sui graphql: ${body.errors.map((e) => e.message).join("; ")}`);
  const pkg = body.data?.packageVersions?.nodes?.[0];
  if (!pkg) throw new Error(`sui graphql: no package at ${originalId}`);
  return { address: pkg.address, version: Number(pkg.version) };
}

async function main(): Promise<void> {
  const env = (process.env.NETWORK ?? "testnet") as WalrusEnv;
  if (env !== "testnet" && env !== "mainnet") throw new Error(`NETWORK must be testnet or mainnet`);
  const lockPath = resolve(import.meta.dirname, "../../contracts/sui/executor/Move.lock");
  const pin = walrusPin(readFileSync(lockPath, "utf8"), env);
  const url = `https://raw.githubusercontent.com/MystenLabs/walrus/${pin.rev}/${pin.subdir}/Published.toml`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const linked = parsePublished(await res.text(), env);
  const verdict = driftVerdict(linked, await latestPackage(env, linked.originalId));
  console.log(`[walrus-drift:${env}] ${verdict.message}`);
  if (!verdict.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[walrus-drift] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
