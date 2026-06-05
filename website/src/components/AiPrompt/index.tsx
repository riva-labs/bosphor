import React, { useState } from 'react';
import styles from './styles.module.css';

interface AiPromptProps {
  children: string;
}

export default function AiPrompt({ children }: AiPromptProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.wrapper}>
      <button
        className={styles.trigger}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className={styles.icon}>&#x2728;</span>
        <span className={styles.label}>Set up with AI</span>
        <span className={styles.tools}>Claude Code, Cursor, Codex</span>
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}>
          &#x25B8;
        </span>
      </button>

      {isOpen && (
        <div className={styles.panel}>
          <p className={styles.instruction}>
            Copy this prompt into your AI coding assistant:
          </p>
          <div className={styles.promptBox}>
            <pre className={styles.promptText}>{children}</pre>
            <button className={styles.copyBtn} onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
