FROM node:22-alpine
WORKDIR /app
# No dependencies to install: the server only uses Node's standard library.
COPY package.json index.html privacy.html impressum.html manifest.webmanifest sw.js favicon.ico robots.txt sitemap.xml ./
COPY css css
COPY js js
COPY img img
COPY fonts fonts
COPY server server
# The journal lives in a volume mounted here; it must belong to the app's user.
RUN mkdir data && chown node data
USER node
ENV PORT=8000
EXPOSE 8000
# node:sqlite still prints an experimental warning on every start.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
