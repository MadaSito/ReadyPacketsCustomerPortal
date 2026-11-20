# Dependency register

Every runtime or build dependency is recorded here with its purpose. Add one row when you add a package
(`scripts/dev/add-dep.sh`). Prefer Node built-ins and packages already present. No package may contact a
third-party service at runtime unless an administrator explicitly configured that integration.

| Package | Scope | Purpose | Notes |
| --- | --- | --- | --- |
| express 5 | runtime | HTTP server | |
| @trpc/server, @trpc/client, @trpc/tanstack-react-query | runtime | typed API | |
| @tanstack/react-query | client | server-state cache | in-memory only |
| zod 4 | runtime | input/config validation | |
| superjson | runtime | tRPC transformer (Date, etc.) | |
| drizzle-orm, mysql2 | runtime | MySQL access (parameterized) | |
| argon2 | runtime | Argon2id password hashing | native addon |
| otpauth | runtime | RFC 6238 TOTP | |
| qrcode | runtime | TOTP enrolment QR rendered locally | no external QR service |
| @simplewebauthn/server, @simplewebauthn/browser | runtime | WebAuthn/passkeys | |
| cookie | runtime | cookie parse/serialize | |
| busboy | runtime | streaming multipart parsing | |
| file-type | runtime | magic-byte detection | |
| nodemailer | runtime | optional SMTP delivery | disabled until configured |
| yazl, yauzl | runtime | archive write/read for portable packages | |
| compression | runtime | static response compression | not applied to secret-bearing dynamic responses |
| react, react-dom 19 | client | UI | |
| wouter | client | routing (path; hash in preview) | |
| radix-ui | client | accessible primitives | |
| lucide-react | client | icons | |
| clsx, tailwind-merge | client | class composition | |
| tailwindcss 4, @tailwindcss/vite, vite 8, @vitejs/plugin-react | build | client build | |
| vite-plugin-pwa, workbox-* | build | static-shell service worker | never caches authenticated data |
| typescript 6 (lint), typescript7 alias (typecheck) | dev | type checking | typescript-eslint does not yet support TS 7 |
| tsx, esbuild | dev/build | run + bundle server | |
| drizzle-kit | dev | migration generation, test schema | |
| vitest, @vitest/coverage-v8, supertest, @testing-library/*, jsdom, axe-core | dev | tests | |
| eslint, typescript-eslint, eslint-plugin-react-hooks, eslint-plugin-jsx-a11y | dev | lint | |
