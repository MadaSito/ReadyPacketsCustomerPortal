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
| playwright-core (Apache-2.0) | dev | Shared Chromium driver for local accessibility and responsive QA | Uses an operator-provided executable; does not download browsers on install or ship in the portal |
| eslint, typescript-eslint, eslint-plugin-react-hooks, eslint-plugin-jsx-a11y | dev | lint | |
| mammoth 1.13 (BSD-2-Clause) | client | read `.docx` into HTML for the in-portal document editor and policy import | browser only, lazy chunk; never imported by `server/`; output is sanitised before use |
| docx 9 (MIT) | client | build a `.docx` from the editor content ("Save as new version") | browser only, lazy chunk; no network |
| pdfjs-dist 6 (Apache-2.0) | client | extract text from a PDF for policy import | browser only, lazy chunk; worker from the same origin; `isEvalSupported: false`; no remote fonts or cmaps |
| @tiptap/extension-table, @tiptap/extension-text-align 3.35.0 (MIT) | client | tables and alignment in the document editor | same version as the other tiptap packages |
| @napi-rs/canvas 1.2.0 (MIT) | dev | lets jsdom measure text so axe evaluates text-in-name rules in tests | devDependency only; `pnpm-workspace.yaml` ignores it as an optional dependency of pdfjs-dist, so the native binary is not in production installs and the server never loads it |
| @node-saml/node-saml 5.2.0 (MIT) | server | SAML 2.0 service provider for Microsoft Entra ID (increment 07, D10) | pinned exactly; used directly (no passport); brings xml-crypto 6.4.0 and @xmldom/xmldom 0.8.15 (patched lines for the 2025 signature-wrapping advisories); our wrapper repeats every check (signed assertion, audience, recipient, InResponseTo, time bounds, pinned certificates); `pnpm audit --prod` clean on 2026-11-24 |
