import React from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

interface RelatedLinkProps {
  href: string;
  description?: string;
}

function isExternal(href: string): boolean {
  return /^https?:\/\//.test(href);
}

export default function RelatedLink({
  href,
  description,
}: RelatedLinkProps): React.ReactElement {
  const external = isExternal(href);

  // Derive a display title from the href when it is internal.
  // Strips leading slash, the .md/.mdx extension, and converts hyphens to spaces.
  const title = external
    ? href.replace(/^https?:\/\//, '').split('/')[0]
    : href
        .replace(/^\//, '')
        .replace(/\.(mdx?|html?)$/, '')
        .replace(/\//g, ' / ')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.link}
      >
        <span className={styles.content}>
          <span className={styles.title}>{title}</span>
          {description && (
            <span className={styles.description}>{description}</span>
          )}
        </span>
        <span className={styles.icon} aria-hidden="true">
          &#x2197;
        </span>
      </a>
    );
  }

  return (
    <Link to={href} className={styles.link}>
      <span className={styles.content}>
        <span className={styles.title}>{title}</span>
        {description && (
          <span className={styles.description}>{description}</span>
        )}
      </span>
      <span className={styles.icon} aria-hidden="true">
        &#x2192;
      </span>
    </Link>
  );
}
