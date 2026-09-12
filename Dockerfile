FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
  && corepack prepare pnpm@10.15.1 --activate

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/llm-gateway/package.json apps/llm-gateway/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/provider-openai/package.json packages/provider-openai/package.json
COPY packages/provider-chatgpt/package.json packages/provider-chatgpt/package.json
COPY packages/provider-fireworks/package.json packages/provider-fireworks/package.json

RUN pnpm install --frozen-lockfile

COPY apps/llm-gateway apps/llm-gateway
COPY packages packages

RUN pnpm build \
  && pnpm store prune

USER node

CMD ["node", "apps/llm-gateway/dist/index.js"]
