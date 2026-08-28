import React from 'react';
import { Cards, Card } from '@site/src/components/Cards';
import styles from './styles.module.css';

export default function HomepageHero(): React.ReactElement {
  return (
    <div className={styles.heroSection}>
      <h2 className={styles.heroTitle}>What is Bosphor?</h2>
      <p className={styles.heroSubtitle}>
        Bosphor is a cross-chain storage intent router. Submit a compact
        commitment from any EVM chain or Solana, and Bosphor routes it through
        LayerZero v2 to Walrus on Sui, returning a DVN-verified proof back to
        your origin chain. The file travels out-of-band, so the cross-chain fee
        is flat regardless of size. One <code>store()</code> call, fully
        trustless.
      </p>
      <Cards>
        <Card
          title="SDK docs"
          href="https://sdk.bosphor.xyz"
          description="Integrate Bosphor from EVM or Solana with @bosphor/sdk. Guides and the full API reference."
        />
        <Card
          title="Architecture"
          href="/architecture"
          description="Understand the system design, message flow, and trust model behind cross-chain storage routing."
        />
        <Card
          title="Quickstart"
          href="/quickstart"
          description="Deploy and run the full pipeline on testnet in 15 minutes."
        />
      </Cards>
      <hr className={styles.divider} />
    </div>
  );
}
