'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, Loader2, Wallet } from 'lucide-react';
import { TESTNET, walrusBlobUrl, type PricedQuote, type StoreProgress } from '@bosphor/sdk';
import { formatBytes, formatNative, shortHex, type Chain } from './format';
import type { Eip1193, StoreRunResult } from './evm-store';
import type { PickedFile } from './playground';
import { primaryBtn, secondaryBtn } from './ui';

const FAUCET_URL = 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia';
const SOLANA_STARTER_URL = 'https://github.com/riva-labs/bosphor-solana-starter';
/** Rough headroom for the submit gas on Sepolia, on top of the quote. */
const GAS_HEADROOM_WEI = 1_000_000_000_000_000n / 1000n; // 0.001 ETH

type Step = StoreProgress['step'];
const STEPS: { step: Step; title: string; active: string }[] = [
  { step: 'encoded', title: 'Encode', active: 'Deriving the Walrus blob id from your bytes' },
  { step: 'quoted', title: 'Quote', active: 'Pricing the store with the relayer' },
  { step: 'submitted', title: 'Submit and pay', active: 'Confirm in your wallet, then wait for the Sepolia block' },
  { step: 'uploaded', title: 'Upload', active: 'Handing the bytes to the relayer' },
  {
    step: 'proven',
    title: 'Proof returned',
    active: 'LayerZero carries the intent to Sui, the relayer stores on Walrus, and the proof comes back. Usually 1 to 3 minutes.',
  },
];

interface WalletState {
  address: string;
  chainId: number;
  balance: bigint | null;
}

type Run =
  | { phase: 'idle' }
  | { phase: 'running'; startedAt: number; events: Partial<Record<Step, { at: number; e: StoreProgress }>> }
  | { phase: 'done'; startedAt: number; events: Partial<Record<Step, { at: number; e: StoreProgress }>>; result: StoreRunResult; endedAt: number }
  | { phase: 'error'; startedAt: number; events: Partial<Record<Step, { at: number; e: StoreProgress }>>; message: string };

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-fd-primary underline decoration-fd-primary/40 underline-offset-2 hover:decoration-fd-primary"
    >
      {children}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}

function sampleFile(): PickedFile {
  const text = `Stored from the Bosphor playground on ${new Date().toISOString()}.\nPaid once on Ethereum Sepolia, kept on Walrus.\n`;
  return { name: 'playground-sample.txt', type: 'text/plain', bytes: new TextEncoder().encode(text) };
}

export function StorePanel({
  chain,
  epochs,
  file,
  quote,
  onUseSample,
  onRunningChange,
}: {
  chain: Chain;
  epochs: number;
  file: PickedFile | null;
  quote: PricedQuote | undefined;
  onUseSample: (f: PickedFile) => void;
  onRunningChange: (running: boolean) => void;
}) {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  const [now, setNow] = useState(0);
  const providerRef = useRef<Eip1193 | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const running = run.phase === 'running';
  useEffect(() => onRunningChange(running), [running, onRunningChange]);

  // Tick once a second while a store runs, for the elapsed timers.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const refresh = useCallback(async (address?: string) => {
    const w = providerRef.current;
    if (!w) return;
    const mod = await import('./evm-store');
    const [chainId, accounts] = await Promise.all([
      mod.readChainId(w),
      address ? Promise.resolve([address]) : (w.request({ method: 'eth_accounts' }) as Promise<string[]>),
    ]);
    const addr = accounts[0];
    if (!addr) return setWallet(null);
    const balance = chainId === mod.SEPOLIA_CHAIN_ID ? await mod.readBalance(w, addr).catch(() => null) : null;
    setWallet({ address: addr, chainId, balance });
  }, []);

  // Follow account and network changes made in the wallet.
  useEffect(() => {
    const w = providerRef.current;
    if (!w || !wallet) return;
    const onAccounts = (accounts: string[]) => (accounts[0] ? void refresh(accounts[0]) : setWallet(null));
    const onChain = () => void refresh();
    w.on?.('accountsChanged', onAccounts as never);
    w.on?.('chainChanged', onChain as never);
    return () => {
      w.removeListener?.('accountsChanged', onAccounts as never);
      w.removeListener?.('chainChanged', onChain as never);
    };
  }, [wallet, refresh]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const connect = async () => {
    setWalletError(null);
    const mod = await import('./evm-store');
    const w = mod.injectedWallet();
    if (!w) return setNoWallet(true);
    providerRef.current = w;
    setBusy(true);
    try {
      await refresh(await mod.requestAccount(w));
    } catch (err) {
      setWalletError(mod.describeStoreError(err));
    } finally {
      setBusy(false);
    }
  };

  const switchChain = async () => {
    const w = providerRef.current;
    if (!w) return;
    setWalletError(null);
    setBusy(true);
    try {
      const mod = await import('./evm-store');
      await mod.switchToSepolia(w);
      await refresh();
    } catch (err) {
      const mod = await import('./evm-store');
      setWalletError(mod.describeStoreError(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const w = providerRef.current;
    if (!w || !file) return;
    const ac = new AbortController();
    abortRef.current = ac;
    const startedAt = Date.now();
    const events: Partial<Record<Step, { at: number; e: StoreProgress }>> = {};
    setRun({ phase: 'running', startedAt, events: {} });
    const mod = await import('./evm-store');
    try {
      const result = await mod.runEvmStore({
        wallet: w,
        data: file.bytes,
        epochs,
        signal: ac.signal,
        onProgress: (e) => {
          events[e.step] = { at: Date.now(), e };
          setRun({ phase: 'running', startedAt, events: { ...events } });
        },
      });
      setRun({ phase: 'done', startedAt, events: { ...events }, result, endedAt: Date.now() });
      void refresh();
    } catch (err) {
      setRun({ phase: 'error', startedAt, events: { ...events }, message: mod.describeStoreError(err) });
      void refresh();
    }
  };

  if (chain === 'solana') {
    return (
      <Shell>
        <p className="text-sm text-fd-muted-foreground">
          A Solana store signs the submit with a keypair today, so it runs from a script rather than a
          browser wallet. The <ExtLink href={SOLANA_STARTER_URL}>Solana starter</ExtLink> does the full
          paid round-trip on devnet in a few commands. To try a store from this page, switch the origin
          chain to Ethereum Sepolia.
        </p>
      </Shell>
    );
  }

  const onSepolia = wallet?.chainId === 11155111;
  const need = quote ? quote.totalNative + GAS_HEADROOM_WEI : null;
  const enough = need !== null && wallet?.balance != null ? wallet.balance >= need : null;
  const events = run.phase === 'idle' ? {} : run.events;

  return (
    <Shell>
      <p className="text-sm text-fd-muted-foreground">
        Store a real file on the hosted testnet from your browser wallet. Your wallet signs one transaction on
        Sepolia; this page never sees a private key. Test ETH only.
      </p>

      {/* 1. Wallet */}
      <div className="flex flex-wrap items-center gap-3">
        {!wallet ? (
          <button type="button" className={primaryBtn} onClick={connect} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wallet className="size-4" aria-hidden />}
            Connect wallet
          </button>
        ) : (
          <>
            <span className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-xs text-fd-foreground">
              <span className={`size-2 rounded-full ${onSepolia ? 'bg-fd-success' : 'bg-fd-warning'}`} aria-hidden />
              {shortHex(wallet.address, 6, 4)}
            </span>
            {onSepolia ? (
              <span className="text-xs text-fd-muted-foreground">
                Ethereum Sepolia
                {wallet.balance != null ? `, ${formatNative(wallet.balance, 18, 4)} ETH` : ''}
              </span>
            ) : (
              <button type="button" className={secondaryBtn} onClick={switchChain} disabled={busy || running}>
                Switch to Sepolia
              </button>
            )}
          </>
        )}
      </div>
      {noWallet ? (
        <p className="text-sm text-fd-warning">
          No browser wallet found. Install one such as <ExtLink href="https://metamask.io/download/">MetaMask</ExtLink>,
          or use the <ExtLink href="https://github.com/riva-labs/bosphor-evm-starter">EVM starter</ExtLink> from a
          script.
        </p>
      ) : null}
      {walletError ? <p className="text-sm text-fd-error">{walletError}</p> : null}

      {/* 2. Readiness */}
      {wallet && onSepolia ? (
        <div className="space-y-2 text-sm">
          {!file ? (
            <p className="text-fd-muted-foreground">
              Drop a file in the price panel above, or{' '}
              <button
                type="button"
                className="text-fd-primary underline decoration-fd-primary/40 underline-offset-2 hover:decoration-fd-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
                onClick={() => onUseSample(sampleFile())}
              >
                use a small sample file
              </button>
              .
            </p>
          ) : !quote ? (
            <p className="text-fd-muted-foreground">Waiting for a live quote for this file...</p>
          ) : enough === false ? (
            <p className="text-fd-warning">
              This store needs about {formatNative(need!, 18, 4)} ETH including gas; your balance is{' '}
              {formatNative(wallet.balance ?? 0n, 18, 4)} ETH. Get test ETH from a{' '}
              <ExtLink href={FAUCET_URL}>Sepolia faucet</ExtLink>, then come back.
            </p>
          ) : (
            <p className="text-fd-muted-foreground">
              Ready: {file.name} ({formatBytes(file.bytes.length)}) for {epochs} epochs. You pay{' '}
              <span className="font-mono text-fd-foreground">{formatNative(quote.totalNative, 18)} ETH</span> plus gas.
              The price is re-quoted at submit, so it can move slightly.
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              className={primaryBtn}
              disabled={!file || !quote || enough === false || running}
              onClick={start}
            >
              {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {running ? 'Storing...' : run.phase === 'idle' ? 'Store on testnet' : 'Store again'}
            </button>
            {running ? (
              <button type="button" className={secondaryBtn} onClick={() => abortRef.current?.abort()}>
                Stop watching
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 3. Timeline */}
      {run.phase !== 'idle' ? <Timeline run={run} events={events} now={now} /> : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-fd-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <span className="text-sm font-medium text-fd-foreground">Run a real store</span>
        <span className="text-xs text-fd-muted-foreground">optional, needs a testnet wallet</span>
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </div>
  );
}

function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function Timeline({
  run,
  events,
  now,
}: {
  run: Exclude<Run, { phase: 'idle' }>;
  events: Partial<Record<Step, { at: number; e: StoreProgress }>>;
  now: number;
}) {
  const firstPending = STEPS.findIndex((s) => !events[s.step]);
  const submitted = events.submitted?.e as Extract<StoreProgress, { step: 'submitted' }> | undefined;
  const encoded = events.encoded?.e as Extract<StoreProgress, { step: 'encoded' }> | undefined;
  const quoted = events.quoted?.e as Extract<StoreProgress, { step: 'quoted' }> | undefined;
  // Each step's clock starts when the previous one finished.
  const startOf = STEPS.map((_, i) =>
    STEPS.slice(0, i).reduce((at, s) => events[s.step]?.at ?? at, run.startedAt),
  );

  return (
    <div className="space-y-3">
      <ol className="relative space-y-0">
        {STEPS.map((s, i) => {
          const ev = events[s.step];
          const state = ev ? 'done' : i === firstPending ? (run.phase === 'error' ? 'error' : run.phase === 'running' ? 'active' : 'pending') : 'pending';
          const took = ev ? ev.at - startOf[i]! : state === 'active' ? Math.max(0, now - startOf[i]!) : null;
          return (
            <li key={s.step} className="flex gap-3 pb-3 last:pb-0">
              <div className="flex flex-col items-center">
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                    state === 'done'
                      ? 'border-fd-success/50 bg-fd-success/15 text-fd-success'
                      : state === 'active'
                        ? 'border-fd-foreground/40 text-fd-foreground'
                        : state === 'error'
                          ? 'border-fd-error/50 bg-fd-error/15 text-fd-error'
                          : 'text-fd-muted-foreground'
                  }`}
                >
                  {state === 'done' ? (
                    <Check className="size-3.5" aria-label="done" />
                  ) : state === 'active' ? (
                    <Loader2 className="size-3.5 animate-spin" aria-label="in progress" />
                  ) : state === 'error' ? (
                    <CircleAlert className="size-3.5" aria-label="failed" />
                  ) : (
                    i + 1
                  )}
                </span>
                {i < STEPS.length - 1 ? <span className="mt-1 w-px flex-1 bg-fd-border" aria-hidden /> : null}
              </div>
              <div className="min-w-0 flex-1 pb-1 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={state === 'pending' ? 'text-fd-muted-foreground' : 'font-medium text-fd-foreground'}>{s.title}</span>
                  {took !== null ? <span className="font-mono text-xs tabular-nums text-fd-muted-foreground">{seconds(took)}</span> : null}
                </div>
                {state === 'active' ? <p className="text-xs text-fd-muted-foreground">{s.active}</p> : null}
                {state === 'error' && run.phase === 'error' ? <p className="text-xs text-fd-error">{run.message}</p> : null}
                <StepDetail step={s.step} encoded={encoded} quoted={quoted} submitted={submitted} done={!!ev} active={state === 'active'} />
              </div>
            </li>
          );
        })}
      </ol>

      {run.phase === 'done' ? <Verified result={run.result} took={run.endedAt - run.startedAt} /> : null}
    </div>
  );
}

function StepDetail({
  step,
  encoded,
  quoted,
  submitted,
  done,
  active,
}: {
  step: Step;
  encoded: Extract<StoreProgress, { step: 'encoded' }> | undefined;
  quoted: Extract<StoreProgress, { step: 'quoted' }> | undefined;
  submitted: Extract<StoreProgress, { step: 'submitted' }> | undefined;
  done: boolean;
  active: boolean;
}) {
  const cls = 'mt-0.5 break-all text-xs text-fd-muted-foreground';
  if (step === 'encoded' && done && encoded) return <p className={cls}>Blob id <span className="font-mono">{shortHex(encoded.encoded.blobId)}</span></p>;
  if (step === 'quoted' && done && quoted) return <p className={cls}>Paying <span className="font-mono">{formatNative(quoted.amount, 18)} ETH</span></p>;
  if (step === 'submitted' && done && submitted) {
    return (
      <p className={cls}>
        Intent <span className="font-mono">{shortHex(submitted.intentId)}</span>,{' '}
        <ExtLink href={`${TESTNET.evm.explorerUrl}/tx/${submitted.txHash}`}>view on Etherscan</ExtLink>
      </p>
    );
  }
  if (step === 'proven' && (active || done) && submitted) {
    return (
      <p className={cls}>
        <ExtLink href={`${TESTNET.layerZeroScanUrl}/tx/${submitted.txHash}`}>Follow the message on LayerZero Scan</ExtLink>
      </p>
    );
  }
  return null;
}

function Verified({ result, took }: { result: StoreRunResult; took: number }) {
  const url = walrusBlobUrl(result.blobId);
  return (
    <div className="space-y-2 rounded-lg border border-fd-success/40 bg-fd-success/10 p-4 text-sm">
      <p className="flex items-center gap-2 font-medium text-fd-foreground">
        <Check className="size-4 text-fd-success" aria-hidden /> Stored and verified in {seconds(took)}
      </p>
      <p className="text-fd-muted-foreground">
        The proof landed on Sepolia and released the escrow. Your file is on Walrus until epoch{' '}
        <span className="font-mono text-fd-foreground">{result.endEpoch.toString()}</span>.
      </p>
      <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-fd-muted-foreground">Intent id</dt>
        <dd className="break-all font-mono text-fd-foreground">{result.intentId}</dd>
        <dt className="text-fd-muted-foreground">Blob id</dt>
        <dd className="break-all font-mono text-fd-foreground">{result.blobId}</dd>
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
        <ExtLink href={url}>View the file on the Walrus aggregator</ExtLink>
        {result.txHash ? (
          <>
            <ExtLink href={`${TESTNET.evm.explorerUrl}/tx/${result.txHash}`}>Submit transaction</ExtLink>
            <ExtLink href={`${TESTNET.layerZeroScanUrl}/tx/${result.txHash}`}>LayerZero Scan</ExtLink>
          </>
        ) : null}
      </div>
    </div>
  );
}
