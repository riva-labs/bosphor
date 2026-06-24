import React from 'react';
import { Cards, Card } from '@site/src/components/Cards';
import styles from './styles.module.css';

export default function HomepageHero(): React.ReactElement {
  return (
    <div className={styles.heroSection}>
      <img
        src="/img/mascot/bosphor_wave.webp"
        alt="Bosphor beaver mascot waving"
        className={styles.mascot}
        loading="eager"
      />
      <h2 className={styles.heroTitle}>What is Bosphor?</h2>
      <p className={styles.heroSubtitle}>
        Bosphor is a cross-chain storage intent router. Submit a storage intent
        on any EVM chain, and Bosphor routes it through LayerZero v2 to Walrus
        on Sui, returning a DVN-verified proof back to your origin chain. One
        Solidity call, fully trustless.
      </p>
      <Cards>
        <Card
          title="Architecture"
          href="/architecture"
          icon="/img/mascot/bosphor_cube.webp"
          description="Understand the system design, message flow, and trust model behind cross-chain storage routing."
        />
        <Card
          title="Quickstart"
          href="/quickstart"
          icon="/img/mascot/bosphor_peek.webp"
          description="Deploy and run the full pipeline on testnet in 15 minutes."
        />
        <Card
          title="Deployment"
          href="/deployment"
          icon="/img/mascot/bosphor_code.webp"
          description="Step-by-step guide for deploying contracts, the relayer, and wiring peers."
        />
      </Cards>
      <hr className={styles.divider} />
    </div>
  );
}
