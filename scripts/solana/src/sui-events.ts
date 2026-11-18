/**
 * Sui event reads for the Sui -> Solana return leg, over GraphQL.
 *
 * Sui JSON-RPC (suix_queryEvents / sui_getTransactionBlock) was shut off on the
 * public testnet endpoints in 2026-10, which silently stalled the return worker.
 * This module serves the same data from the Sui GraphQL API and keeps the
 * JSON-RPC result shape the callers were written against:
 *   - events are `{ type, parsedJson }`, newest first
 *   - pages are `{ data, hasNextPage, nextCursor }`, where the next page is OLDER
 * Mirrors bosphor-dvn's src/sui-events.ts (the Sui -> EVM worker).
 */

export interface SuiEvent {
  type: string;
  parsedJson: Record<string, unknown>;
}

export interface SuiEventPage {
  data: SuiEvent[];
  hasNextPage: boolean;
  nextCursor: string | null;
}

/**
 * Resilient GraphQL call: retries on network errors, non-2xx, empty / non-JSON
 * bodies and GraphQL errors. Reads the body as text first so a truncated response
 * never throws an unhandled SyntaxError that kills the worker's poll loop.
 */
export async function suiGraphql(
  url: string,
  query: string,
  variables: Record<string, unknown>,
  attempts = 4,
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const text = await res.text();
      if (!res.ok || !text) throw new Error(`sui graphql ${res.status} (${text.length} bytes)`);
      const d = JSON.parse(text);
      if (d.errors?.length) throw new Error(`sui graphql error: ${JSON.stringify(d.errors).slice(0, 500)}`);
      return d.data;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

interface GqlEventNode {
  contents: { type: { repr: string }; json: Record<string, unknown> };
}

function toEvent(n: GqlEventNode): SuiEvent {
  return { type: n.contents.type.repr, parsedJson: n.contents.json };
}

const EVENTS_QUERY = `
query ($sender: SuiAddress!, $type: String, $last: Int!, $before: String) {
  events(last: $last, before: $before, filter: { sender: $sender, type: $type }) {
    pageInfo { hasPreviousPage startCursor }
    nodes { contents { type { repr } json } }
  }
}`;

/**
 * Events emitted by `sender`'s transactions, optionally narrowed to one Move
 * event type, newest first. Pass a page's `nextCursor` to walk further back.
 */
export async function queryEventsBySender(
  url: string,
  sender: string,
  opts: { type?: string; limit: number; cursor?: string | null },
): Promise<SuiEventPage> {
  const data = await suiGraphql(url, EVENTS_QUERY, {
    sender,
    type: opts.type ?? null,
    last: opts.limit,
    before: opts.cursor ?? null,
  });
  const conn = data?.events;
  const nodes: GqlEventNode[] = conn?.nodes ?? [];
  // GraphQL returns the window oldest -> newest; JSON-RPC callers expect newest first.
  return {
    data: nodes.map(toEvent).reverse(),
    hasNextPage: Boolean(conn?.pageInfo?.hasPreviousPage),
    nextCursor: conn?.pageInfo?.startCursor ?? null,
  };
}

const TX_EVENTS_QUERY = `
query ($digest: String!) {
  transaction(digest: $digest) {
    effects { events { nodes { contents { type { repr } json } } } }
  }
}`;

/** All events emitted by one transaction, in emission order. */
export async function transactionEvents(url: string, digest: string): Promise<SuiEvent[]> {
  const data = await suiGraphql(url, TX_EVENTS_QUERY, { digest });
  const tx = data?.transaction;
  if (!tx) throw new Error(`sui tx ${digest} not found`);
  return ((tx.effects?.events?.nodes ?? []) as GqlEventNode[]).map(toEvent);
}

/**
 * Normalize a Move `vector<u8>` field to 0x-hex. GraphQL renders it as base64;
 * JSON-RPC rendered it as a number array. A 0x string is passed through.
 */
export function bytesFieldToHex(v: unknown): string | null {
  if (Array.isArray(v)) return "0x" + Buffer.from(v as number[]).toString("hex");
  if (typeof v !== "string" || !v) return null;
  if (v.startsWith("0x")) return v;
  return "0x" + Buffer.from(v, "base64").toString("hex");
}
