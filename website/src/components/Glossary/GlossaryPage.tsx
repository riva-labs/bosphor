import React, { useMemo } from 'react';
import styles from './styles.module.css';
import glossaryData from '@site/static/glossary.json';

interface GlossaryEntry {
  term: string;
  id: string;
  aliases?: string[];
  description: string;
}

const entries = glossaryData as GlossaryEntry[];

export default function GlossaryPage(): React.ReactElement {
  const grouped = useMemo(() => {
    const map: Record<string, GlossaryEntry[]> = {};
    for (const entry of entries) {
      const letter = entry.term[0].toUpperCase();
      if (!map[letter]) map[letter] = [];
      map[letter].push(entry);
    }
    // Sort entries within each letter
    for (const letter of Object.keys(map)) {
      map[letter].sort((a, b) => a.term.localeCompare(b.term));
    }
    return map;
  }, []);

  const letters = useMemo(() => Object.keys(grouped).sort(), [grouped]);

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  return (
    <div className={styles.glossaryPage}>
      <nav className={styles.alphabetNav} aria-label="Glossary alphabet navigation">
        {alphabet.map((letter) => {
          const hasEntries = letters.includes(letter);
          return hasEntries ? (
            <a
              key={letter}
              href={`#letter-${letter}`}
              className={styles.alphabetLink}
            >
              {letter}
            </a>
          ) : (
            <span
              key={letter}
              className={styles.alphabetLinkDisabled}
            >
              {letter}
            </span>
          );
        })}
      </nav>

      {letters.map((letter) => (
        <div key={letter} className={styles.letterSection}>
          <h2 id={`letter-${letter}`} className={styles.letterHeading}>
            {letter}
          </h2>
          {grouped[letter].map((entry) => (
            <div key={entry.id} id={entry.id} className={styles.glossaryEntry}>
              <h3 className={styles.entryTerm}>
                {entry.term}
                {entry.aliases && entry.aliases.length > 0 && (
                  <span className={styles.entryAliases}>
                    {' '}({entry.aliases.join(', ')})
                  </span>
                )}
              </h3>
              <p className={styles.entryDescription}>{entry.description}</p>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
