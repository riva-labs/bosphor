"use client";

import { motion } from "framer-motion";
import BeaverMascot from "./BeaverMascot";

export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center overflow-hidden bg-bg-primary pt-16">
      {/* Background wordmark */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none select-none"
        aria-hidden="true"
      >
        <span className="font-[family-name:var(--font-satoshi)] text-[12vw] sm:text-[10vw] font-black text-text-heading opacity-[0.08] whitespace-nowrap">
          BOSPHOR
        </span>
      </div>

      <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 w-full">
        <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-16 py-12 sm:py-20">
          {/* Text content */}
          <div className="flex-1 text-center lg:text-left">
            {/* Status badge */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 py-1 text-xs font-medium text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                Live on Testnet
              </span>
            </motion.div>

            {/* Headline */}
            <motion.h1
              className="mt-6 font-[family-name:var(--font-satoshi)] text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-black leading-[1.1] tracking-tight text-text-heading"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
            >
              MAKING WALRUS
              <br />
              CHAIN-AGNOSTIC
            </motion.h1>

            {/* Subtitle */}
            <motion.p
              className="mt-6 max-w-xl text-base sm:text-lg leading-relaxed text-text-body mx-auto lg:mx-0"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
            >
              Cross-chain storage intent routing. Store on Walrus from any EVM
              chain, with DVN-verified proof back to origin.
            </motion.p>

            {/* CTAs */}
            <motion.div
              className="mt-8 flex flex-col sm:flex-row items-center gap-4 justify-center lg:justify-start"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
            >
              <a
                href="https://docs.bosphor.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-12 items-center justify-center rounded-lg bg-text-heading px-6 text-sm font-medium text-bg-primary transition-opacity hover:opacity-90 w-full sm:w-auto"
              >
                Go to Docs
              </a>
              <a
                href="https://github.com/riva-labs/bosphor"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-12 items-center justify-center rounded-lg border border-surface-3 px-6 text-sm font-medium text-text-body transition-colors hover:border-text-muted hover:text-text-heading w-full sm:w-auto"
              >
                View on GitHub
              </a>
            </motion.div>
          </div>

          {/* Beaver mascot */}
          <motion.div
            className="flex-shrink-0"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.3 }}
          >
            <BeaverMascot
              pose="01_waving"
              size={320}
              className="w-48 sm:w-64 lg:w-80 h-auto opacity-80"
            />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
