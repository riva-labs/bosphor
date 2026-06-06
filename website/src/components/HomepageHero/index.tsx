import React from 'react';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

const cards = [
  {
    title: 'Architecture',
    description:
      'Understand the system design, message flow, and trust model behind cross-chain storage routing.',
    href: '/architecture',
    icon: '/img/mascot/03_blueprint.png',
  },
  {
    title: 'Quickstart',
    description:
      'Deploy and run the full pipeline on testnet in 15 minutes.',
    href: '/quickstart',
    icon: '/img/mascot/05_running.png',
  },
  {
    title: 'Deployment',
    description:
      'Step-by-step guide for deploying contracts, the relayer, and wiring peers.',
    href: '/deployment',
    icon: '/img/mascot/19_deploying.png',
  },
];

export default function HomepageHero(): React.ReactElement {
  return (
    <div className={styles.heroSection}>
      <img
        src="/img/mascot/01_waving.png"
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
      <div className={styles.cards}>
        {cards.map((card) => (
          <Link key={card.href} to={card.href} className={styles.card}>
            <img
              src={card.icon}
              alt={card.title}
              className={styles.cardIcon}
              loading="lazy"
            />
            <div className={styles.cardTitle}>{card.title}</div>
            <p className={styles.cardDescription}>{card.description}</p>
          </Link>
        ))}
      </div>
      <hr className={styles.divider} />
    </div>
  );
}
