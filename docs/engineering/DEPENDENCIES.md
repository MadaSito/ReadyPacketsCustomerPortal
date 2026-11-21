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
| mmdb-lib 3.0.5 (MIT) | runtime | read an operator-provided local MaxMind-format country database | no built-in MMDB parser; no cloud lookup, SDK transport or network dependency |
| react, react-dom 19 | client | UI | |
| wouter | client | routing (path; hash in preview) | |
| radix-ui | client | accessible primitives | |
| lucide-react | client | icons | |
| clsx, tailwind-merge | client | class composition | |
| @xyflow/react 13.0.2 (MIT) | client | FlowCanvas (workflow designer, automation canvas) in `client/src/ui` | Lazy route chunk only. CSP: creates no `<style>` elements and never sets a `style` attribute; positions go through React style props (CSSOM, not governed by `style-src`). Its static CSS is bundled into our stylesheet. No network access. |
| @tiptap/core, @tiptap/react, @tiptap/pm, @tiptap/starter-kit, @tiptap/extension-image 3.35.0 (MIT; open-source extensions only, no Pro) | client | RichTextEditor for HTML e-mail bodies in `client/src/ui` | Lazy route chunk only. CSP: core would inject a `<style>` element by default, so the editor is always created with `injectCSS: false` (enforced in our wrapper and its test) and its base CSS is in our stylesheet. ProseMirror uses `style.cssText` (CSSOM) only. Output is re-sanitised on the server. No network access. |
| tailwindcss 4, @tailwindcss/vite, vite 8, @vitejs/plugin-react | build | client build | |
| vite-plugin-pwa, workbox-* | build | static-shell service worker | never caches authenticated data |
| typescript 6 (lint), typescript7 alias (typecheck) | dev | type checking | typescript-eslint does not yet support TS 7 |
| tsx, esbuild | dev/build | run + bundle server | |
| drizzle-kit | dev | migration generation, test schema | |
| vitest, @vitest/coverage-v8, supertest, @testing-library/*, jsdom, axe-core | dev | tests | |
| eslint, typescript-eslint, eslint-plugin-react-hooks, eslint-plugin-jsx-a11y | dev | lint | |
