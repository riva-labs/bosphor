import React, { useState, useRef, useEffect } from 'react';
import styles from './styles.module.css';

interface OpenInAgentButtonProps {
  code: string;
  language?: string;
  prompt?: string;
}

const agents = [
  {
    name: 'Claude',
    url: (q: string) => `https://claude.ai/new?q=${encodeURIComponent(q)}`,
  },
  {
    name: 'ChatGPT',
    url: (q: string) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  },
  {
    name: 'Gemini',
    url: (q: string) =>
      `https://gemini.google.com/app?q=${encodeURIComponent(q)}`,
  },
];

export default function OpenInAgentButton({
  code,
  language,
  prompt = 'Explain this code',
}: OpenInAgentButtonProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const lang = language ?? '';
  const fullPrompt = `${prompt}\n\n\`\`\`${lang}\n${code}\n\`\`\``;

  return (
    <div className={styles.container} ref={ref}>
      <button
        className={styles.button}
        onClick={() => setOpen(!open)}
        aria-label="Open in AI agent"
        aria-expanded={open}
        title="Open in AI agent"
      >
        <svg
          className={styles.aiIcon}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M8 1L10 5.5L15 6.5L11.5 10L12.5 15L8 12.5L3.5 15L4.5 10L1 6.5L6 5.5L8 1Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className={styles.dropdown}>
          {agents.map((agent) => (
            <a
              key={agent.name}
              href={agent.url(fullPrompt)}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.dropdownItem}
              onClick={() => setOpen(false)}
            >
              {agent.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
