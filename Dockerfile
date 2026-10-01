# champctl, every program in one image. deploy/compose.yml decides which one a
# container runs; docs/deployment.md is the operator's side of this file.
#
# Not to be confused with docker/, which is a throwaway ACSM for tests.

FROM node:22-slim AS build
WORKDIR /src

# --ignore-scripts because `prepare` runs the build, and the sources aren't
# here yet. esbuild ships its binary as a platform package, so skipping its
# postinstall check loses nothing.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src src
COPY client client
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY LICENSE ./
COPY bin bin
COPY profiles profiles
COPY --from=build /src/dist dist
RUN for f in bin/*.js; do ln -s "/app/$f" "/usr/local/bin/$(basename "$f" .js)"; done

# Every default path — the response cache, the archive, the livery queue — is
# relative to the working directory, so running from the data volume puts all
# of it there without a flag. Created here and owned by `node` so a fresh named
# volume inherits that ownership: the databases are written 0600 by whoever
# runs, and root-owned files would lock out the next container.
RUN mkdir -p /var/lib/champctl && chown node:node /var/lib/champctl
WORKDIR /var/lib/champctl
USER node

CMD ["champctl-serve", "--host", "0.0.0.0", "--trust-proxy"]
