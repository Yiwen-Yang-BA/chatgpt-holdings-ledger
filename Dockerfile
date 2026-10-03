FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . .
ENV HOST=0.0.0.0 PORT=3208
USER node
EXPOSE 3208
CMD ["node", "--env-file-if-exists=.env", "server.mjs"]
