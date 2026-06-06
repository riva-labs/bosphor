import React from 'react';
import type { ReactNode } from 'react';
import styles from './styles.module.css';

interface CardsProps {
  children: ReactNode;
  className?: string;
}

export default function Cards({ children, className }: CardsProps): React.ReactElement {
  return (
    <div className={`${styles.grid} ${className ?? ''}`}>
      {children}
    </div>
  );
}
