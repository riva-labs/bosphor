import React, { useState, useRef, useEffect } from 'react';
import styles from './styles.module.css';

interface AgentPromptProps {
  prompt: string;
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

export default function AgentPrompt({
  prompt,
}: AgentPromptProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.label}>AI Prompt</span>
      </div>
      <pre className={styles.promptText}>{prompt}</pre>
      <div className={styles.actions}>
        <div className={styles.dropdownContainer} ref={dropdownRef}>
          <button
            className={styles.openBtn}
            onClick={() => setDropdownOpen(!dropdownOpen)}
            aria-expanded={dropdownOpen}
          >
            Open in...
            <span
              className={`${styles.chevron} ${dropdownOpen ? styles.chevronOpen : ''}`}
            >
              &#x25BE;
            </span>
          </button>
          {dropdownOpen && (
            <div className={styles.dropdown}>
              {agents.map((agent) => (
                <a
                  key={agent.name}
                  href={agent.url(prompt)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.dropdownItem}
                  onClick={() => setDropdownOpen(false)}
                >
                  {agent.name}
                </a>
              ))}
            </div>
          )}
        </div>
        <button className={styles.copyBtn} onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
