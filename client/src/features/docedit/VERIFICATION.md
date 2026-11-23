# `docedit` + `docconvert` Verification Notes (Increment 06 Package C)

## Commands Verified
1. `source scripts/dev/env.sh && pnpm exec eslint client/src/lib/docconvert client/src/features/docedit --max-warnings 0`
2. `scripts/dev/tc.sh`
3. `scripts/dev/test.sh client/src/lib/docconvert/docconvert.test.tsx`
4. `scripts/dev/test.sh client/src/features/docedit/docedit.test.tsx`

## Controls Verified
- **Browser-only lazy chunks & strict CSP**: `mammoth`, `docx`, `pdfjs-dist`, `@tiptap/extension-table`, and `@tiptap/extension-text-align` load strictly in client chunks; `pdfToText` runs with same-origin bundled worker and `isEvalSupported: false` + `useWasm: false`; `docxToHtml` runs inside a terminable same-origin Web Worker and fails closed if `Worker` is unavailable; TipTap runs with `injectCSS: false` and emits zero inline `style` attributes.
- **ZIP & size guards**: 10 MB byte limit, Central-Directory <-> Local-Header coherence, unique canonical entry names, non-overlapping member bounds, bounded stream inflation (50 MB max inflated bytes, <= 100x compression ratio, <= 1,000 entries), clamped 200-page PDF limit, and cumulative extracted-character cap.
- **Zero browser storage & honest limits notice**: Draft HTML stays strictly in React state; `OrderDocumentEditView` displays general Word editing limits plus detected unsupported OOXML elements (`headers`, `footers`, `comments`, `trackChanges`, `textBoxes`, `footnotes`, `complexFields`) before editing and preserves earlier versions on save.
