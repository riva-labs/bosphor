'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** A one-line shell command with a copy button, for the home page. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-fd-background/60 px-3 py-2 font-mono text-sm">
      <span className="select-none text-fd-muted-foreground" aria-hidden>
        $
      </span>
      <code className="flex-1 truncate text-fd-foreground">{command}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : `Copy "${command}"`}
        className="rounded-md p-1 text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
