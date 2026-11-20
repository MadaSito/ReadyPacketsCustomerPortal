// Readiness probe for the web container (container health check and rp-docker.sh).
// The web process listens only on its address on the proxy network, so the probe connects there and
// names the portal host, exactly as the proxy does. Exit status 0 means "ready".
import http from "node:http";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5000);
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
let authority = `127.0.0.1:${port}`;
if (!loopback) {
  try {
    authority = new URL(process.env.RP_CANONICAL_ORIGIN).host;
  } catch {
    process.exit(1);
  }
}

const request = http.get(
  { host: loopback ? "127.0.0.1" : host, port, path: "/readyz", headers: { Host: authority }, timeout: 4000 },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
request.on("timeout", () => request.destroy(new Error("timeout")));
request.on("error", () => process.exit(1));
