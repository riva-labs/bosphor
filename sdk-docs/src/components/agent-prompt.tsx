'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Sparkles } from 'lucide-react';

// A ready-made prompt a reader can copy or open in an AI assistant. Ported from
// the Docusaurus site's AgentPrompt so migrated pages keep the same affordance.
const agents = [
  { name: 'Claude', url: (q: string) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
  { name: 'ChatGPT', url: (q: string) => `https://chatgpt.com/?q=${encodeURIComponent(q)}` },
  { name: 'Gemini', url: (q: string) => `https://gemini.google.com/app?q=${encodeURIComponent(q)}` },
];

export function AgentPrompt({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const copy = async () => {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border bg-fd-card text-sm">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Sparkles className="size-3.5 text-fd-muted-foreground" aria-hidden />
        <span className="font-mono text-xs font-medium uppercase tracking-wider text-fd-muted-foreground">
          AI prompt
        </span>
      </div>
      <p className="whitespace-pre-wrap px-4 py-3 leading-relaxed text-fd-foreground/90">{prompt}</p>
      <div className="flex items-center gap-2 border-t px-4 py-2">
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-haspopup="menu"
            className="inline-flex items-center gap-1 rounded-md border bg-fd-secondary px-2.5 py-1 text-xs font-medium text-fd-secondary-foreground transition-colors hover:bg-fd-accent"
          >
            Open in
            <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
          </button>
          {open ? (
            <div
              role="menu"
              className="absolute bottom-full left-0 z-20 mb-1 min-w-36 overflow-hidden rounded-lg border bg-fd-popover py-1 shadow-lg"
            >
              {agents.map((agent) => (
                <a
                  key={agent.name}
                  role="menuitem"
                  href={agent.url(prompt)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="block px-3 py-1.5 text-xs text-fd-popover-foreground hover:bg-fd-accent"
                >
                  {agent.name}
                </a>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-fd-foreground px-2.5 py-1 text-xs font-medium text-fd-background transition-opacity hover:opacity-90"
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
      </div>
    </div>
  );
}
