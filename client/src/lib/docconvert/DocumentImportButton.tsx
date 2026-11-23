/**
 * Reusable accessible document import button (`.docx`, `.md`, `.pdf`) -> sanitised content + warnings (D12).
 * Used in compliance policy editing and reusable wherever admins/staff import rich or plain policy text.
 * Designed and tested against WCAG 2.2 AA (labelled file trigger, `aria-describedby` format hint, live status).
 */
import { useId, useRef, useState, type ChangeEvent } from "react";
import { Button, Callout } from "@/ui";
import {
  DocConvertError,
  MAX_DOCCONVERT_BYTES,
  type DocConvertOptions,
  type DocumentImportResult,
  type DocumentImportSourceKind,
} from "./types";
import { docxToHtml } from "./docxToHtml";
import { markdownToHtml } from "./markdown";
import { pdfToText } from "./pdfToText";

export interface DocumentImportButtonProps extends DocConvertOptions {
  readonly onImport: (result: DocumentImportResult) => void;
  readonly onError?: (error: DocConvertError) => void;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly variant?: "secondary" | "ghost" | "primary";
  readonly size?: "sm" | "md";
  /** Show inline warnings/error feedback directly below the button (default true). */
  readonly showInlineFeedback?: boolean;
  readonly className?: string;
}

const ACCEPTED_INPUT =
  ".docx,.md,.markdown,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,application/pdf";

export function detectImportSourceKind(file: File): DocumentImportSourceKind | null {
  const lower = file.name.trim().toLowerCase();
  const mime = (file.type || "").trim().toLowerCase();

  if (
    lower.endsWith(".docx") ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    mime === "text/markdown" ||
    mime === "text/x-markdown"
  ) {
    return "markdown";
  }
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    return "pdf";
  }
  return null;
}

export async function importDocumentFile(
  file: File,
  options?: DocConvertOptions,
): Promise<DocumentImportResult> {
  const sourceKind = detectImportSourceKind(file);
  if (!sourceKind) {
    throw new DocConvertError(
      "UNSUPPORTED_FORMAT",
      "Unsupported file format. Choose a Word (.docx), Markdown (.md), or PDF (.pdf) file.",
    );
  }

  if (sourceKind === "docx") {
    const res = await docxToHtml(file, options);
    return {
      sourceFormat: "docx",
      sourceKind: "docx",
      fileName: file.name,
      sanitizedHtml: res.sanitizedHtml,
      markdown: res.markdown,
      plainText: res.plainText,
      suggestedPolicyFormat: "safe_markdown",
      warnings: res.warnings,
      detectedUnsupported: res.detectedUnsupported,
    };
  }

  if (sourceKind === "markdown") {
    const res = await markdownToHtml(file, options);
    return {
      sourceFormat: "markdown",
      sourceKind: "markdown",
      fileName: file.name,
      sanitizedHtml: res.sanitizedHtml,
      markdown: res.markdown,
      plainText: res.plainText,
      suggestedPolicyFormat: "safe_markdown",
      warnings: res.warnings,
    };
  }

  const res = await pdfToText(file, options);
  return {
    sourceFormat: "pdf",
    sourceKind: "pdf",
    fileName: file.name,
    sanitizedHtml: res.sanitizedHtml,
    markdown: res.markdown,
    plainText: res.plainText,
    suggestedPolicyFormat: "plain_text",
    warnings: res.warnings,
    pageCount: res.pageCount,
  };
}

export function DocumentImportButton({
  onImport,
  onError,
  label = "Import from file",
  disabled = false,
  variant = "secondary",
  size = "sm",
  showInlineFeedback = true,
  maxBytes = MAX_DOCCONVERT_BYTES,
  timeoutMs,
  className,
}: DocumentImportButtonProps) {
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<{
    fileName: string;
    sourceKind: DocumentImportSourceKind;
    warnings: readonly string[];
  } | null>(null);

  const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    setErrorMessage(null);
    setImportSummary(null);

    try {
      const result = await importDocumentFile(file, { maxBytes, timeoutMs });
      setImportSummary({
        fileName: result.fileName,
        sourceKind: result.sourceKind,
        warnings: result.warnings,
      });
      onImport(result);
    } catch (err) {
      const normalized =
        err instanceof DocConvertError
          ? err
          : new DocConvertError(
              "DOCX_PARSE_FAILED",
              "Unable to import this file. Verify the file is valid and under the size limit.",
            );
      setErrorMessage(normalized.message);
      onError?.(normalized);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={className ? `rp-stack-2 ${className}` : "rp-stack-2"}>
      <div className="rp-row rp-row--wrap">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_INPUT}
          onChange={(e) => {
            void handleFileChange(e);
          }}
          disabled={disabled || busy}
          tabIndex={-1}
          aria-hidden="true"
          hidden
          data-testid="document-import-file-input"
        />
        <Button
          type="button"
          variant={variant}
          size={size}
          loading={busy}
          disabled={disabled}
          aria-describedby={hintId}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Importing document..." : label}
        </Button>
        <span id={hintId} className="rp-field__hint">
          Supports .docx, .md, and .pdf (up to {maxMb} MB; PDF imports text only).
        </span>
      </div>

      {showInlineFeedback && errorMessage ? (
        <Callout tone="danger" title="Document import failed">
          {errorMessage}
        </Callout>
      ) : null}

      {showInlineFeedback && importSummary && importSummary.warnings.length > 0 ? (
        <Callout
          tone="warning"
          title={
            importSummary.sourceKind === "pdf"
              ? `Imported text from ${importSummary.fileName}`
              : `Imported ${importSummary.fileName} with formatting notes`
          }
        >
          <ul className="rp-stack-1">
            {importSummary.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </div>
  );
}
