'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileUp, Loader2, RefreshCw, X } from 'lucide-react';
import type { PricedQuote } from '@bosphor/sdk';
import {
  CHAINS,
  DEFAULT_EPOCHS,
  MAX_BLOB_BYTES,
  MAX_EPOCHS,
  MIN_EPOCHS,
  SIZE_PRESETS,
  TESTNET_EPOCH_DAYS,
  formatBytes,
  formatNative,
  formatUsd,
  type Chain,
} from './format';
import { CodePanel } from './code-panel';
import { StorePanel } from './store-panel';
import { primaryBtn, secondaryBtn } from './ui';

export interface PickedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

type QuoteState =
  | { status: 'idle' }
  | { status: 'loading'; previous?: PricedQuote }
  | { status: 'ready'; quote: PricedQuote; at: number }
  | { status: 'error'; message: string; retryAt?: number };

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-fd-foreground">{label}</span>
        {hint ? <span className="text-xs text-fd-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children, disabled }: { active: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? 'border-fd-foreground/40 bg-fd-accent font-medium text-fd-accent-foreground'
          : 'text-fd-muted-foreground hover:bg-fd-accent/60 hover:text-fd-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/** The live playground: price a store with no wallet, then optionally run one. */
export function Playground() {
  const [chain, setChain] = useState<Chain>('evm');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [presetBytes, setPresetBytes] = useState(1024);
  const [epochs, setEpochs] = useState(DEFAULT_EPOCHS);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [live, setLive] = useState(false);
  const [quote, setQuote] = useState<QuoteState>({ status: 'idle' });
  const [storeRunning, setStoreRunning] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sizeBytes = file ? file.bytes.length : presetBytes;
  const locked = storeRunning;

  const pickFile = useCallback(async (f: File | undefined) => {
    if (!f) return;
    setFileError(null);
    if (f.size === 0) return setFileError('That file is empty.');
    if (f.size > MAX_BLOB_BYTES) {
      return setFileError(`The hosted testnet stores files up to ${formatBytes(MAX_BLOB_BYTES)}. This one is ${formatBytes(f.size)}.`);
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    setFile({ name: f.name, type: f.type || 'application/octet-stream', bytes });
  }, []);

  const runQuote = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setQuote((q) => ({ status: 'loading', previous: q.status === 'ready' ? q.quote : q.status === 'loading' ? q.previous : undefined }));
    try {
      const { fetchPlaygroundQuote } = await import('./quote');
      const result = await fetchPlaygroundQuote({ chain, sizeBytes, epochs, signal: ac.signal });
      if (!ac.signal.aborted) setQuote({ status: 'ready', quote: result, at: Date.now() });
    } catch (err) {
      if (ac.signal.aborted) return;
      const { describeQuoteError, RateLimitedError } = await import('./quote');
      setQuote({
        status: 'error',
        message: describeQuoteError(err),
        ...(err instanceof RateLimitedError ? { retryAt: Date.now() + err.retryAfterSeconds * 1000 } : {}),
      });
    }
  }, [chain, sizeBytes, epochs]);

  // Once the reader asked for a first quote, re-price on every change (debounced).
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(runQuote, 350);
    return () => clearTimeout(t);
  }, [live, runQuote]);

  // Rate limited: count down, then retry on our own.
  const retryAt = quote.status === 'error' ? quote.retryAt : undefined;
  useEffect(() => {
    if (!retryAt) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const retry = setTimeout(runQuote, Math.max(0, retryAt - Date.now()));
    return () => {
      clearInterval(tick);
      clearTimeout(retry);
    };
  }, [retryAt, runQuote]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const shownQuote = quote.status === 'ready' ? quote.quote : quote.status === 'loading' ? quote.previous : undefined;
  const meta = CHAINS[chain];

  return (
    <div className="not-prose my-6 space-y-4">
      <div className="overflow-hidden rounded-xl border bg-fd-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <span className="text-sm font-medium text-fd-foreground">Price a store</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-fd-warning/40 bg-fd-warning/10 px-2.5 py-0.5 text-xs font-medium text-fd-warning">
            <span className="size-1.5 rounded-full bg-fd-warning" aria-hidden />
            Hosted testnet, live prices
          </span>
        </div>

        <div className="grid gap-0 md:grid-cols-2">
          {/* Options */}
          <div className="space-y-5 p-4 md:border-r">
            <Field label="Origin chain" hint="where you pay">
              <div className="flex flex-wrap gap-2">
                {(Object.keys(CHAINS) as Chain[]).map((c) => (
                  <Chip key={c} active={chain === c} disabled={locked} onClick={() => setChain(c)}>
                    {CHAINS[c].network}
                  </Chip>
                ))}
              </div>
            </Field>

            <Field label="File" hint={`up to ${formatBytes(MAX_BLOB_BYTES)}`}>
              <div
                role="button"
                tabIndex={locked ? -1 : 0}
                aria-disabled={locked}
                aria-label="Choose a file, or drop one here"
                onClick={() => !locked && inputRef.current?.click()}
                onKeyDown={(e) => {
                  if (!locked && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    inputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!locked) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (!locked) void pickFile(e.dataTransfer.files[0]);
                }}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring ${
                  dragging ? 'border-fd-foreground/50 bg-fd-accent' : 'hover:bg-fd-accent/50'
                } ${locked ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <FileUp className="size-4 shrink-0 text-fd-muted-foreground" aria-hidden />
                {file ? (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-fd-foreground">{file.name}</span>
                    <span className="text-xs text-fd-muted-foreground">{formatBytes(file.bytes.length)}</span>
                  </span>
                ) : (
                  <span className="flex-1 text-fd-muted-foreground">Drop a file here, or click to choose one</span>
                )}
                {file && !locked ? (
                  <button
                    type="button"
                    aria-label="Remove file"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                    className="rounded-md p-1 text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
                <input
                  ref={inputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    void pickFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </div>
              {fileError ? <p className="text-xs text-fd-error">{fileError}</p> : null}
              {!file ? (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-fd-muted-foreground">or pick a size:</span>
                  {SIZE_PRESETS.map((p) => (
                    <Chip key={p.bytes} active={presetBytes === p.bytes} disabled={locked} onClick={() => setPresetBytes(p.bytes)}>
                      {p.label}
                    </Chip>
                  ))}
                </div>
              ) : null}
            </Field>

            <Field
              label="Storage duration"
              hint={`${epochs} epoch${epochs === 1 ? '' : 's'}, about ${epochs * TESTNET_EPOCH_DAYS} day${epochs * TESTNET_EPOCH_DAYS === 1 ? '' : 's'} on testnet`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={MIN_EPOCHS}
                  max={MAX_EPOCHS}
                  value={epochs}
                  disabled={locked}
                  aria-label="Storage epochs"
                  onChange={(e) => setEpochs(Number(e.target.value))}
                  className="h-1.5 flex-1 cursor-pointer accent-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
                />
                <input
                  type="number"
                  min={MIN_EPOCHS}
                  max={MAX_EPOCHS}
                  value={epochs}
                  disabled={locked}
                  aria-label="Storage epochs (number)"
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    if (Number.isFinite(n)) setEpochs(Math.min(MAX_EPOCHS, Math.max(MIN_EPOCHS, n)));
                  }}
                  className="w-16 rounded-md border bg-fd-background px-2 py-1 text-right font-mono text-sm text-fd-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
                />
              </div>
            </Field>

            {!live ? (
              <button type="button" className={primaryBtn} onClick={() => setLive(true)}>
                Get a live quote
              </button>
            ) : (
              <p className="text-xs text-fd-muted-foreground">The quote refreshes as you change the options.</p>
            )}
          </div>

          {/* Result */}
          <div className="p-4" aria-live="polite">
            <QuoteResult
              state={quote}
              quote={shownQuote}
              sizeBytes={sizeBytes}
              epochs={epochs}
              now={now}
              onRetry={runQuote}
            />
          </div>
        </div>
      </div>

      <CodePanel chain={chain} sizeBytes={sizeBytes} epochs={epochs} {...(file ? { fileName: file.name } : {})} />

      <StorePanel
        chain={chain}
        epochs={epochs}
        file={file}
        quote={quote.status === 'ready' && quote.quote.originToken === meta.symbol ? quote.quote : undefined}
        onUseSample={(sample) => {
          setFile(sample);
          setLive(true);
        }}
        onRunningChange={setStoreRunning}
      />
    </div>
  );
}

function Row({ label, usd, note, strong }: { label: string; usd: number; note?: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1.5 ${strong ? 'border-t pt-2.5 font-medium text-fd-foreground' : 'text-fd-muted-foreground'}`}>
      <span>
        {label}
        {note ? <span className="ml-1.5 text-xs text-fd-muted-foreground/80">{note}</span> : null}
      </span>
      <span className="font-mono tabular-nums">{formatUsd(usd)}</span>
    </div>
  );
}

function QuoteResult({
  state,
  quote,
  sizeBytes,
  epochs,
  now,
  onRetry,
}: {
  state: QuoteState;
  quote: PricedQuote | undefined;
  sizeBytes: number;
  epochs: number;
  now: number;
  onRetry: () => void;
}) {
  if (state.status === 'idle') {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center text-sm text-fd-muted-foreground">
        <p>Pick a chain, a file or size, and a duration.</p>
        <p>
          The quote comes live from the hosted testnet relayer and chain, through the same SDK call shown
          below. No wallet needed.
        </p>
      </div>
    );
  }

  if (state.status === 'error') {
    const wait = state.retryAt ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : null;
    return (
      <div className="flex h-full min-h-48 flex-col items-start justify-center gap-3 rounded-lg border border-fd-error/40 bg-fd-error/10 p-4 text-sm">
        <p className="font-medium text-fd-foreground">No quote right now</p>
        <p className="text-fd-muted-foreground">{state.message}</p>
        {wait !== null ? (
          <p className="text-xs text-fd-muted-foreground">Retrying automatically in {wait}s.</p>
        ) : (
          <button type="button" className={secondaryBtn} onClick={onRetry}>
            <RefreshCw className="size-3.5" aria-hidden /> Try again
          </button>
        )}
      </div>
    );
  }

  if (!quote) {
    return (
      <div className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-fd-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Pricing {formatBytes(sizeBytes)} for {epochs} epochs...
      </div>
    );
  }

  // Quotes for the other chain can linger for a moment while re-pricing.
  const qMeta = quote.originToken === 'SOL' ? CHAINS.solana : CHAINS.evm;
  const b = quote.breakdown;
  const buffer = Math.max(0, b.bufferedEscrowUsd - b.walCostUsd - b.suiGasUsd - b.returnLzUsd);
  const loading = state.status === 'loading';

  return (
    <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      <div>
        <div className="flex items-center gap-2 text-xs text-fd-muted-foreground">
          You pay once, on {qMeta.network}
          {loading ? <Loader2 className="size-3 animate-spin" aria-label="Updating" /> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
          <span className="font-mono text-2xl font-semibold tabular-nums text-fd-foreground">
            {formatNative(quote.totalNative, qMeta.decimals)} {qMeta.symbol}
          </span>
          <span className="text-sm text-fd-muted-foreground">about {formatUsd(b.totalUsd)}</span>
        </div>
        {quote.forwardIsUpperBound ? (
          <p className="mt-1 text-xs text-fd-muted-foreground">
            Upper bound: the LayerZero fee is the preset cap, the live fee charged is lower.
          </p>
        ) : null}
      </div>

      <div className="text-sm">
        <Row label="Walrus storage" note="WAL" usd={b.walCostUsd} />
        <Row label="Sui gas" usd={b.suiGasUsd} />
        <Row label="LayerZero return" note="proof back to origin" usd={b.returnLzUsd} />
        {buffer > 0.00005 ? <Row label="Price buffer" note="covers price moves" usd={buffer} /> : null}
        <Row label="Service margin" usd={b.serviceMarginUsd} />
        <Row label="LayerZero forward" note={quote.forwardIsUpperBound ? 'cap' : 'intent to Sui'} usd={b.forwardUsd} />
        <Row label="Total" usd={b.totalUsd} strong />
      </div>

      <div className="grid gap-2 text-xs text-fd-muted-foreground sm:grid-cols-2">
        <div className="rounded-lg border px-3 py-2">
          <div className="font-mono text-fd-foreground">
            {formatNative(quote.escrowNative, qMeta.decimals)} {qMeta.symbol}
          </div>
          Held in escrow, released only when the storage proof returns. Refundable if it never does.
        </div>
        <div className="rounded-lg border px-3 py-2">
          <div className="font-mono text-fd-foreground">
            {formatNative(quote.forwardNative, qMeta.decimals)} {qMeta.symbol}
          </div>
          LayerZero fee for the forward message, paid at submit.
        </div>
      </div>
      {b.floorApplied ? <p className="text-xs text-fd-muted-foreground">The minimum price applies to this store.</p> : null}
      <p className="text-xs text-fd-muted-foreground">
        {formatBytes(sizeBytes)} for {epochs} epochs from {qMeta.network}. Testnet prices use live token rates;
        origin gas is paid separately by your wallet.
      </p>
    </div>
  );
}
