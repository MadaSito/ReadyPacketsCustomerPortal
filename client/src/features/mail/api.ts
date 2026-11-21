/**
 * Typed tRPC bridge for `client/src/features/mail/**` (Package E).
 * Keeps `tc.sh` clean both before and after partner modules land their router additions.
 */
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type {
  AuditCopyVerificationStatus,
  GraphMailConfigView,
  GraphMailUpdateInput,
  MailTransportTestResult,
  PlatformSettingRow,
  SmtpConfigView,
  SmtpUpdateInput,
} from "./model";

interface QueryProcNoInput<TOutput> {
  queryOptions(opts?: Record<string, unknown>): UseQueryOptions<TOutput, unknown, TOutput, readonly unknown[]>;
  queryKey(): readonly unknown[];
}

interface MutationProc<TInput, TOutput> {
  mutationOptions(opts?: UseMutationOptions<TOutput, unknown, TInput>): UseMutationOptions<TOutput, unknown, TInput>;
}

export interface MailTRPCProxy {
  platformSettingsList: QueryProcNoInput<PlatformSettingRow[]>;
  platformSettingsUpdate: MutationProc<{ key: string; value: unknown; expectedVersion: number }, unknown>;
  smtpGet: QueryProcNoInput<SmtpConfigView>;
  smtpUpdate: MutationProc<SmtpUpdateInput, SmtpConfigView>;
  smtpSendTest: MutationProc<{ toAddress?: string }, MailTransportTestResult>;
  graphGet: QueryProcNoInput<GraphMailConfigView>;
  graphUpdate: MutationProc<GraphMailUpdateInput, GraphMailConfigView>;
  graphSendTest: MutationProc<Record<string, never>, MailTransportTestResult>;
  auditCopyStatus: QueryProcNoInput<AuditCopyVerificationStatus>;
  auditCopyRequestVerification: MutationProc<void, { queued: boolean }>;
  auditCopyConfirmVerification: MutationProc<{ code: string }, { verified: boolean }>;
}

export interface MailDirectClient {
  updatePlatformSetting(input: { key: string; value: unknown; expectedVersion: number }): Promise<unknown>;
  updateSmtp(input: SmtpUpdateInput): Promise<SmtpConfigView>;
  sendSmtpTest(input: { toAddress?: string }): Promise<MailTransportTestResult>;
  updateGraph(input: GraphMailUpdateInput): Promise<GraphMailConfigView>;
  sendGraphTest(input: Record<string, never>): Promise<MailTransportTestResult>;
  requestAuditCopyVerification(): Promise<{ queued: boolean }>;
  confirmAuditCopyVerification(input: { code: string }): Promise<{ verified: boolean }>;
}

export function useMailTRPC(): MailTRPCProxy {
  const trpc = useTRPC() as unknown as {
    platform: {
      admin: {
        settings: {
          list: QueryProcNoInput<PlatformSettingRow[]>;
          update: MutationProc<{ key: string; value: unknown; expectedVersion: number }, unknown>;
        };
      };
    };
    integrations: {
      admin: {
        smtp: {
          get: QueryProcNoInput<SmtpConfigView>;
          update: MutationProc<SmtpUpdateInput, SmtpConfigView>;
          sendTest: MutationProc<{ toAddress?: string }, MailTransportTestResult>;
        };
        graph: {
          get: QueryProcNoInput<GraphMailConfigView>;
          update: MutationProc<GraphMailUpdateInput, GraphMailConfigView>;
          sendTest: MutationProc<Record<string, never>, MailTransportTestResult>;
        };
      };
    };
    jobs: {
      mail: {
        auditCopy: {
          status: QueryProcNoInput<AuditCopyVerificationStatus>;
          requestVerification: MutationProc<void, { queued: boolean }>;
          confirmVerification: MutationProc<{ code: string }, { verified: boolean }>;
        };
      };
    };
  };

  return {
    platformSettingsList: trpc.platform.admin.settings.list,
    platformSettingsUpdate: trpc.platform.admin.settings.update,
    smtpGet: trpc.integrations.admin.smtp.get,
    smtpUpdate: trpc.integrations.admin.smtp.update,
    smtpSendTest: trpc.integrations.admin.smtp.sendTest,
    graphGet: trpc.integrations.admin.graph.get,
    graphUpdate: trpc.integrations.admin.graph.update,
    graphSendTest: trpc.integrations.admin.graph.sendTest,
    auditCopyStatus: trpc.jobs.mail.auditCopy.status,
    auditCopyRequestVerification: trpc.jobs.mail.auditCopy.requestVerification,
    auditCopyConfirmVerification: trpc.jobs.mail.auditCopy.confirmVerification,
  };
}

export function useMailClient(): MailDirectClient {
  const client = useTRPCClient() as unknown as {
    platform: {
      admin: {
        settings: {
          update: { mutate(input: { key: string; value: unknown; expectedVersion: number }): Promise<unknown> };
        };
      };
    };
    integrations: {
      admin: {
        smtp: {
          update: { mutate(input: SmtpUpdateInput): Promise<SmtpConfigView> };
          sendTest: { mutate(input: { toAddress?: string }): Promise<MailTransportTestResult> };
        };
        graph: {
          update: { mutate(input: GraphMailUpdateInput): Promise<GraphMailConfigView> };
          sendTest: { mutate(input: Record<string, never>): Promise<MailTransportTestResult> };
        };
      };
    };
    jobs: {
      mail: {
        auditCopy: {
          requestVerification: { mutate(): Promise<{ queued: boolean }> };
          confirmVerification: { mutate(input: { code: string }): Promise<{ verified: boolean }> };
        };
      };
    };
  };

  return {
    updatePlatformSetting: (input) => client.platform.admin.settings.update.mutate(input),
    updateSmtp: (input) => client.integrations.admin.smtp.update.mutate(input),
    sendSmtpTest: (input) => client.integrations.admin.smtp.sendTest.mutate(input),
    updateGraph: (input) => client.integrations.admin.graph.update.mutate(input),
    sendGraphTest: (input) => client.integrations.admin.graph.sendTest.mutate(input),
    requestAuditCopyVerification: () => client.jobs.mail.auditCopy.requestVerification.mutate(),
    confirmAuditCopyVerification: (input) => client.jobs.mail.auditCopy.confirmVerification.mutate(input),
  };
}
