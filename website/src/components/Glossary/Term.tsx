import React, { useState, useRef, useEffect, useCallback } from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';
import glossaryData from '@site/static/glossary.json';

interface GlossaryEntry {
  term: string;
  id: string;
  aliases?: string[];
  description: string;
}

interface TermProps {
  id: string;
  children: React.ReactNode;
}

const entriesById: Record<string, GlossaryEntry> = {};
for (const entry of glossaryData as GlossaryEntry[]) {
  entriesById[entry.id] = entry;
}

export default function Term({ id, children }: TermProps): React.ReactElement {
  const [visible, setVisible] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const entry = entriesById[id];

  const show = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setVisible(true);
  }, []);

  const hide = useCallback(() => {
    timeoutRef.current = setTimeout(() => setVisible(false), 150);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  if (!entry) {
    return <>{children}</>;
  }

  return (
    <span
      ref={wrapperRef}
      className={styles.termWrapper}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span
        className={styles.term}
        tabIndex={0}
        role="button"
        aria-describedby={`tooltip-${id}`}
      >
        {children}
      </span>
      {visible && (
        <span
          id={`tooltip-${id}`}
          className={styles.tooltip}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <span className={styles.tooltipArrow} />
          <span className={styles.tooltipTitle}>{entry.term}</span>
          <span className={styles.tooltipDescription}>
            {entry.description}
          </span>
          <Link to={`/glossary#${id}`} className={styles.tooltipLink}>
            View in glossary
          </Link>
        </span>
      )}
    </span>
  );
}
