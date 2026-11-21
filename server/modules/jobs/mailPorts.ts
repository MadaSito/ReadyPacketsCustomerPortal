import type { OutboundMail, Tx } from "../../core/types.js";

export type MailTransportKey = "smtp" | "graph";

export interface MailSenderIdentity {
  fromAddress: string;
  fromName: string;
  replyToAddress?: string;
}

export interface MailTransportMessage {
  sender: MailSenderIdentity;
  to: string;
  subject: string;
  text: string;
  html: string;
  signal: AbortSignal;
}

export interface MailTransportResult {
  outcome: "accepted" | "not_configured" | "rejected" | "unknown";
  retryable?: boolean;
  /** Optional provider-owned fixed classification; never log untrusted detail. */
  safeDetail?: string;
}

export interface MailTransport {
  readonly key: MailTransportKey;
  isConfigured(): Promise<boolean>;
  send(input: MailTransportMessage): Promise<MailTransportResult>;
}

export interface PublishedMailTemplate {
  readonly key: string;
  readonly vars: readonly string[];
  readonly sensitiveVars?: readonly string[];
  render(vars: OutboundMail["vars"]): { subject: string; text: string; html?: string };
}

export interface MailTemplateStore {
  resolve(key: string, tx?: Tx): Promise<PublishedMailTemplate | null>;
}
