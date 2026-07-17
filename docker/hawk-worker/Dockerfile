FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      python3 \
      ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 hawk

WORKDIR /workspace
USER hawk

ENV HAWK_WORKSPACE=/workspace
ENV HAWK_OUTPUT_DIR=/output

ENTRYPOINT []
CMD ["node", "--version"]
