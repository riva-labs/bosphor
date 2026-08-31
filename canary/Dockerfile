# Build context is the repo ROOT (see docker-compose), not ./canary, because the
# canary depends on the sibling SDK via `file:../sdk`.
FROM node:22-slim
WORKDIR /app

# 1. Build the SDK first, with its own devDeps, so dist/ exists. The SDK's
#    tsconfig extends the repo-root tsconfig.base.json, so copy that alongside.
COPY tsconfig.base.json ./
COPY sdk/ ./sdk/
RUN cd sdk && npm install && npm run build

# 2. Install the canary. --install-links COPIES the pre-built @bosphor/sdk into
#    the canary's node_modules (instead of symlinking it), so the SDK's lazy peer
#    imports (@mysten/walrus, @solana/web3.js, ...) resolve from the canary's tree
#    where those peers actually live. A symlinked SDK would resolve them from the
#    SDK's own tree and fail at runtime.
COPY canary/ ./canary/
RUN cd canary && npm install --install-links

WORKDIR /app/canary
CMD ["npm", "start"]
