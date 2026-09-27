'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, Loader2, Wallet } from 'lucide-react';
import { TESTNET, walrusBlobUrl, type PricedQuote, type StoreProgress, type StoreResult } from '@bosphor/sdk';
import { CHAINS, formatBytes, formatNative, shortHex, solscanUrl, type Chain } from './format';
import type { Eip1193 } from './evm-store';
import type { InjectedSolana } from './solana-store';
import type { PickedFile } from './playground';
import { primaryBtn, secondaryBtn } from './ui';

type Step = StoreProgress['step'];
type Events = Partial<Record<Step, { at: number; e: StoreProgress }>>;
type RunResult = StoreResult & { quote: PricedQuote };

type Run =
  | { phase: 'idle' }
  | { phase: 'running'; startedAt: number; events: Events }
  | { phase: 'done'; startedAt: number; events: Events; result: RunResult; endedAt: number }
  | { phase: 'error'; startedAt: number; events: Events; message: string };

/** What differs between the two origin chains in this panel. */
const ORIGIN: Record<
  Chain,
  {
    /** Rough headroom on top of the quote: gas on Sepolia; fees and account rent on Solana. */
    headroom: bigint;
    faucetUrl: string;
    faucetLabel: string;
    explorerName: string;
    txUrl: (hash: string) => string;
    submitActive: string;
    starterUrl: string;
    starterLabel: string;
  }
> = {
  evm: {
    headroom: 1_000_000_000_000_000n / 1000n, // 0.001 ETH
    faucetUrl: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
    faucetLabel: 'Sepolia faucet',
    explorerName: 'Etherscan',
    txUrl: (hash) => `${TESTNET.evm.explorerUrl}/tx/${hash}`,
    submitActive: 'Confirm in your wallet, then wait for the Sepolia block',
    starterUrl: 'https://github.com/riva-labs/bosphor-evm-starter',
    starterLabel: 'EVM starter',
  },
  solana: {
    headroom: 5_000_000n, // 0.005 SOL: the per-intent account rent plus fees
    faucetUrl: 'https://faucet.solana.com',
    faucetLabel: 'Solana devnet faucet',
    explorerName: 'Solscan',
    txUrl: (sig) => solscanUrl('tx', sig),
    submitActive: 'Approve in your wallet, then wait for the devnet confirmation',
    starterUrl: 'https://github.com/riva-labs/bosphor-solana-starter',
    starterLabel: 'Solana starter',
  },
};

const STEPS: { step: Step; title: string; active: (chain: Chain) => string }[] = [
  { step: 'encoded', title: 'Encode', active: () => 'Deriving the Walrus blob id from your bytes' },
  { step: 'quoted', title: 'Quote', active: () => 'Pricing the store with the relayer' },
  { step: 'submitted', title: 'Submit and pay', active: (c) => ORIGIN[c].submitActive },
  { step: 'uploaded', title: 'Upload', active: () => 'Handing the bytes to the relayer' },
  {
    step: 'proven',
    title: 'Proof returned',
    active: () =>
      'LayerZero carries the intent to Sui, the relayer stores on Walrus, and the proof comes back. Usually 1 to 3 minutes.',
  },
];

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

function sampleFile(chain: Chain): PickedFile {
  const text = `Stored from the Bosphor playground on ${new Date().toISOString()}.\nPaid once on ${CHAINS[chain].network}, kept on Walrus.\n`;
  return { name: 'playground-sample.txt', type: 'text/plain', bytes: new TextEncoder().encode(text) };
}

interface PanelProps {
  chain: Chain;
  epochs: number;
  file: PickedFile | null;
  quote: PricedQuote | undefined;
  onUseSample: (f: PickedFile) => void;
  onRunningChange: (running: boolean) => void;
}

export function StorePanel(props: PanelProps) {
  // Keyed so switching chains resets the wallet and run state.
  return props.chain === 'evm' ? <EvmStore key="evm" {...props} /> : <SolanaStore key="solana" {...props} />;
}

/** Run state shared by both chains: the timeline events, the elapsed clock, and cancellation. */
function useStoreRun(chain: Chain, onRunningChange: (running: boolean) => void) {
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const running = run.phase === 'running';

  useEffect(() => onRunningChange(running), [running, onRunningChange]);
  // Tick once a second while a store runs, for the elapsed timers.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async (
    runner: (signal: AbortSignal, onProgress: (e: StoreProgress) => void) => Promise<RunResult>,
    after: () => void,
  ) => {
    const ac = new AbortController();
    abortRef.current = ac;
    const startedAt = Date.now();
    const events: Events = {};
    setRun({ phase: 'running', startedAt, events: {} });
    try {
      const result = await runner(ac.signal, (e) => {
        events[e.step] = { at: Date.now(), e };
        setRun({ phase: 'running', startedAt, events: { ...events } });
      });
      setRun({ phase: 'done', startedAt, events: { ...events }, result, endedAt: Date.now() });
    } catch (err) {
      setRun({ phase: 'error', startedAt, events: { ...events }, message: await describe(err, chain) });
    }
    after();
  };

  return { run, now, running, start, stop: () => abortRef.current?.abort() };
}

async function describe(err: unknown, chain: Chain): Promise<string> {
  const { describeStoreError } = await import('./store-errors');
  return describeStoreError(err, chain);
}

interface EvmWallet {
  address: string;
  chainId: number;
  balance: bigint | null;
}

function EvmStore({ epochs, file, quote, onUseSample, onRunningChange }: PanelProps) {
  const [wallet, setWallet] = useState<EvmWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const [busy, setBusy] = useState(false);
  const providerRef = useRef<Eip1193 | null>(null);
  const { run, now, running, start, stop } = useStoreRun('evm', onRunningChange);

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
      setWalletError(await describe(err, 'evm'));
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
      setWalletError(await describe(err, 'evm'));
    } finally {
      setBusy(false);
    }
  };

  const onSepolia = wallet?.chainId === 11155111;

  return (
    <Shell>
      <p className="text-sm text-fd-muted-foreground">
        Store a real file on the hosted testnet from your browser wallet. Your wallet signs one transaction on
        Sepolia; this page never sees a private key. Test ETH only.
      </p>

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
          or use the <ExtLink href={ORIGIN.evm.starterUrl}>{ORIGIN.evm.starterLabel}</ExtLink> from a script.
        </p>
      ) : null}
      {walletError ? <p className="text-sm text-fd-error">{walletError}</p> : null}

      {wallet && onSepolia ? (
        <Readiness
          chain="evm"
          epochs={epochs}
          file={file}
          quote={quote}
          balance={wallet.balance}
          run={run}
          onUseSample={onUseSample}
          onStart={() => {
            const w = providerRef.current;
            if (!w || !file) return;
            void start(
              async (signal, onProgress) =>
                (await import('./evm-store')).runEvmStore({ wallet: w, data: file.bytes, epochs, signal, onProgress }),
              () => void refresh(),
            );
          }}
          onStop={stop}
        />
      ) : null}

      {run.phase !== 'idle' ? <Timeline chain="evm" run={run} now={now} /> : null}
    </Shell>
  );
}

interface SolanaWallet {
  address: string;
  balance: bigint | null;
}

function SolanaStore({ epochs, file, quote, onUseSample, onRunningChange }: PanelProps) {
  const [wallet, setWallet] = useState<SolanaWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [noWallet, setNoWallet] = useState(false);
  const [busy, setBusy] = useState(false);
  const providerRef = useRef<InjectedSolana | null>(null);
  const { run, now, running, start, stop } = useStoreRun('solana', onRunningChange);

  const refresh = useCallback(async (address: string | null) => {
    if (!address) return setWallet(null);
    const mod = await import('./solana-store');
    const balance = await mod.readSolanaBalance(address).catch(() => null);
    setWallet({ address, balance });
  }, []);

  // Follow account switches and disconnects made in the wallet.
  useEffect(() => {
    const w = providerRef.current;
    if (!w || !wallet) return;
    const onAccount = (pk: { toBase58(): string } | null) => void refresh(pk ? pk.toBase58() : null);
    const onDisconnect = () => setWallet(null);
    w.on?.('accountChanged', onAccount as never);
    w.on?.('disconnect', onDisconnect as never);
    return () => {
      const off = w.off ?? w.removeListener;
      off?.call(w, 'accountChanged', onAccount as never);
      off?.call(w, 'disconnect', onDisconnect as never);
    };
  }, [wallet, refresh]);

  const connect = async () => {
    setWalletError(null);
    const mod = await import('./solana-store');
    const w = mod.injectedSolana();
    if (!w) return setNoWallet(true);
    providerRef.current = w;
    setBusy(true);
    try {
      await refresh(await mod.connectSolana(w));
    } catch (err) {
      setWalletError(await describe(err, 'solana'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <p className="text-sm text-fd-muted-foreground">
        Store a real file on the hosted testnet from Phantom. Your wallet approves one transaction on Solana
        devnet; this page never sees a private key. Devnet SOL only.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {!wallet ? (
          <button type="button" className={primaryBtn} onClick={connect} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wallet className="size-4" aria-hidden />}
            Connect Phantom
          </button>
        ) : (
          <>
            <span className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-xs text-fd-foreground">
              <span className="size-2 rounded-full bg-fd-success" aria-hidden />
              {shortHex(wallet.address, 4, 4)}
            </span>
            <span className="text-xs text-fd-muted-foreground">
              Solana devnet
              {wallet.balance != null ? `, ${formatNative(wallet.balance, 9, 4)} SOL` : ''}
            </span>
          </>
        )}
      </div>
      {noWallet ? (
        <p className="text-sm text-fd-warning">
          No Solana wallet found. Install <ExtLink href="https://phantom.com/download">Phantom</ExtLink>, or use the{' '}
          <ExtLink href={ORIGIN.solana.starterUrl}>{ORIGIN.solana.starterLabel}</ExtLink> from a script.
        </p>
      ) : null}
      {walletError ? <p className="text-sm text-fd-error">{walletError}</p> : null}
      {wallet ? (
        <p className="text-xs text-fd-muted-foreground">
          The balance is read from devnet. In Phantom, turn on Testnet Mode (Settings, Developer Settings) and pick
          Solana Devnet so the wallet shows the same balance and previews the transaction against devnet.
        </p>
      ) : null}

      {wallet ? (
        <Readiness
          chain="solana"
          epochs={epochs}
          file={file}
          quote={quote}
          balance={wallet.balance}
          run={run}
          onUseSample={onUseSample}
          onStart={() => {
            const w = providerRef.current;
            if (!w || !file) return;
            void start(
              async (signal, onProgress) =>
                (await import('./solana-store')).runSolanaStore({ wallet: w, data: file.bytes, epochs, signal, onProgress }),
              () => void refresh(wallet.address),
            );
          }}
          onStop={stop}
        />
      ) : null}

      {run.phase !== 'idle' ? <Timeline chain="solana" run={run} now={now} /> : null}
    </Shell>
  );
}

/** File, quote and balance checks, then the store button. Same for both chains. */
function Readiness({
  chain,
  epochs,
  file,
  quote,
  balance,
  run,
  onUseSample,
  onStart,
  onStop,
}: {
  chain: Chain;
  epochs: number;
  file: PickedFile | null;
  quote: PricedQuote | undefined;
  balance: bigint | null;
  run: Run;
  onUseSample: (f: PickedFile) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const { symbol, decimals } = CHAINS[chain];
  const origin = ORIGIN[chain];
  const running = run.phase === 'running';
  const need = quote ? quote.totalNative + origin.headroom : null;
  const enough = need !== null && balance != null ? balance >= need : null;
  const extra = chain === 'evm' ? 'gas' : 'fees and account rent';

  return (
    <div className="space-y-2 text-sm">
      {!file ? (
        <p className="text-fd-muted-foreground">
          Drop a file in the price panel above, or{' '}
          <button
            type="button"
            className="text-fd-primary underline decoration-fd-primary/40 underline-offset-2 hover:decoration-fd-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            onClick={() => onUseSample(sampleFile(chain))}
          >
            use a small sample file
          </button>
          .
        </p>
      ) : !quote ? (
        <p className="text-fd-muted-foreground">Waiting for a live quote for this file...</p>
      ) : enough === false ? (
        <p className="text-fd-warning">
          This store needs about {formatNative(need!, decimals, 4)} {symbol} including {extra}; your balance is{' '}
          {formatNative(balance ?? 0n, decimals, 4)} {symbol}. Get test {symbol} from the{' '}
          <ExtLink href={origin.faucetUrl}>{origin.faucetLabel}</ExtLink>, then come back.
        </p>
      ) : (
        <p className="text-fd-muted-foreground">
          Ready: {file.name} ({formatBytes(file.bytes.length)}) for {epochs} epochs. You pay{' '}
          <span className="font-mono text-fd-foreground">
            {formatNative(quote.totalNative, decimals)} {symbol}
          </span>{' '}
          plus {extra}. The price is re-quoted at submit, so it can move slightly.
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className={primaryBtn} disabled={!file || !quote || enough === false || running} onClick={onStart}>
          {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {running ? 'Storing...' : run.phase === 'idle' ? 'Store on testnet' : 'Store again'}
        </button>
        {running ? (
          <button type="button" className={secondaryBtn} onClick={onStop}>
            Stop watching
          </button>
        ) : null}
      </div>
    </div>
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

function Timeline({ chain, run, now }: { chain: Chain; run: Exclude<Run, { phase: 'idle' }>; now: number }) {
  const events = run.events;
  const firstPending = STEPS.findIndex((s) => !events[s.step]);
  // Each step's clock starts when the previous one finished.
  const startOf = STEPS.map((_, i) => STEPS.slice(0, i).reduce((at, s) => events[s.step]?.at ?? at, run.startedAt));

  return (
    <div className="space-y-3">
      <ol className="relative space-y-0">
        {STEPS.map((s, i) => {
          const ev = events[s.step];
          const state = ev
            ? 'done'
            : i === firstPending
              ? run.phase === 'error'
                ? 'error'
                : run.phase === 'running'
                  ? 'active'
                  : 'pending'
              : 'pending';
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
                {state === 'active' ? <p className="text-xs text-fd-muted-foreground">{s.active(chain)}</p> : null}
                {state === 'error' && run.phase === 'error' ? <p className="text-xs text-fd-error">{run.message}</p> : null}
                <StepDetail chain={chain} step={s.step} events={events} done={!!ev} active={state === 'active'} />
              </div>
            </li>
          );
        })}
      </ol>

      {run.phase === 'done' ? <Verified chain={chain} result={run.result} took={run.endedAt - run.startedAt} /> : null}
    </div>
  );
}

function StepDetail({ chain, step, events, done, active }: { chain: Chain; step: Step; events: Events; done: boolean; active: boolean }) {
  const cls = 'mt-0.5 break-all text-xs text-fd-muted-foreground';
  const { symbol, decimals } = CHAINS[chain];
  const origin = ORIGIN[chain];
  const encoded = events.encoded?.e as Extract<StoreProgress, { step: 'encoded' }> | undefined;
  const quoted = events.quoted?.e as Extract<StoreProgress, { step: 'quoted' }> | undefined;
  const submitted = events.submitted?.e as Extract<StoreProgress, { step: 'submitted' }> | undefined;
  if (step === 'encoded' && done && encoded) {
    return (
      <p className={cls}>
        Blob id <span className="font-mono">{shortHex(encoded.encoded.blobId)}</span>
      </p>
    );
  }
  if (step === 'quoted' && done && quoted) {
    return (
      <p className={cls}>
        Paying{' '}
        <span className="font-mono">
          {formatNative(quoted.amount, decimals)} {symbol}
        </span>
      </p>
    );
  }
  if (step === 'submitted' && done && submitted) {
    return (
      <p className={cls}>
        Intent <span className="font-mono">{shortHex(submitted.intentId)}</span>,{' '}
        <ExtLink href={origin.txUrl(submitted.txHash)}>view on {origin.explorerName}</ExtLink>
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

function Verified({ chain, result, took }: { chain: Chain; result: RunResult; took: number }) {
  const origin = ORIGIN[chain];
  return (
    <div className="space-y-2 rounded-lg border border-fd-success/40 bg-fd-success/10 p-4 text-sm">
      <p className="flex items-center gap-2 font-medium text-fd-foreground">
        <Check className="size-4 text-fd-success" aria-hidden /> Stored and verified in {seconds(took)}
      </p>
      <p className="text-fd-muted-foreground">
        The proof landed on {CHAINS[chain].network} and released the escrow. Your file is on Walrus until epoch{' '}
        <span className="font-mono text-fd-foreground">{result.endEpoch.toString()}</span>.
      </p>
      <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-fd-muted-foreground">Intent id</dt>
        <dd className="break-all font-mono text-fd-foreground">{result.intentId}</dd>
        <dt className="text-fd-muted-foreground">Blob id</dt>
        <dd className="break-all font-mono text-fd-foreground">{result.blobId}</dd>
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
        <ExtLink href={walrusBlobUrl(result.blobId)}>View the file on the Walrus aggregator</ExtLink>
        <ExtLink href={origin.txUrl(result.txHash)}>Submit transaction on {origin.explorerName}</ExtLink>
        <ExtLink href={`${TESTNET.layerZeroScanUrl}/tx/${result.txHash}`}>LayerZero Scan</ExtLink>
      </div>
    </div>
  );
}
