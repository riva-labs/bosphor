# Container for the self-operated Sui->Solana return worker (solana-return.ts),
# the Solana analogue of bosphor-dvn's dvn-evm-return. Runs the LZ SDK verify +
# commitVerification + lz_receive that releases the M4 escrow on Solana devnet.
# tsx runs the TS directly (matches the toolchain's dev usage).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
# Default entrypoint is the return worker in loop mode; override per compose.
CMD ["npm", "run", "solana-return"]
