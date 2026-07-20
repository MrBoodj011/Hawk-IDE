FROM node:20-alpine

COPY proxy.mjs /opt/hawk/proxy.mjs

USER node
EXPOSE 3128

ENTRYPOINT ["node", "/opt/hawk/proxy.mjs"]
