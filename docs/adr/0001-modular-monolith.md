# 0001 — Clean rebuild as a modular monolith on the specified stack

Status: Accepted (2026-11-20)

## Context
The master prompt and the architecture document require a secure rebuild of the customer portal that is
self-hosted, has no dependency on any hosted AI or vendor identity service, and can be operated by a small team.
The previous code base (`ReadyPackets-SiteSplit`) mixed the public site and portal and carried vendor OAuth.

## Decision
- One deployable Node.js 22 service (Express 5 + tRPC 11) with a React 19 single-page client, MySQL 8.4 through
  Drizzle ORM, and a local private object store. The same artefact runs as `web`, `worker` or `all` (`RP_ROLE`).
- The server is divided into modules (`server/modules/<name>`), each owning its tables, service, router, HTTP
  routes, API description and verification notes. Modules reach one another only through the typed service
  registry built in `server/container.ts`; importing another module's internals is prohibited.
- No code was copied from the previous repository; it was used only as a reference for product behaviour.

## Alternatives rejected
- Microservices: more moving parts than the self-hosted target can justify and a larger attack surface.
- Retaining the previous code: it could not meet the session, audit and custody requirements without a rewrite.

## Consequences
- A module can be extracted later because its boundary is already a typed interface.
- Cross-module consistency relies on shared transactions passed explicitly (`tx` options), not on foreign keys.
