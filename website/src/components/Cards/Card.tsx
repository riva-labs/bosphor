import React from 'react';
import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

interface CardProps {
  title: string;
  href: string;
  description?: string;
  icon?: string;
  children?: ReactNode;
}

function isExternal(href: string): boolean {
  return /^https?:\/\//.test(href);
}

export default function Card({
  title,
  href,
  description,
  icon,
  children,
}: CardProps): React.ReactElement {
  const content = (
    <>
      {icon && (
        <img
          src={icon}
          alt={title}
          className={styles.cardIcon}
          loading="lazy"
        />
      )}
      <div className={styles.cardTitle}>{title}</div>
      {description && <p className={styles.cardDescription}>{description}</p>}
      {children && <div className={styles.cardBody}>{children}</div>}
    </>
  );

  if (isExternal(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.card}
      >
        {content}
      </a>
    );
  }

  return (
    <Link to={href} className={styles.card}>
      {content}
    </Link>
  );
}
