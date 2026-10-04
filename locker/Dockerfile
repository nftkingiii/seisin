# Seisin locker: zcash-devtool (pinned) plus the locker script.
FROM rust:1-bookworm AS build
ARG DEVTOOL_REV=5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/zcash/zcash-devtool /src && git -C /src checkout "$DEVTOOL_REV"
WORKDIR /src
RUN cargo build --release --locked && strip target/release/zcash-devtool

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/zcash-devtool /usr/local/bin/zcash-devtool
WORKDIR /app
COPY locker.mjs .
ENV WALLET_DIR=/wallet DEVTOOL=/usr/local/bin/zcash-devtool
CMD ["node", "locker.mjs"]
