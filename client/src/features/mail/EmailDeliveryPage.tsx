/**
 * /admin/email-delivery — E-mail delivery administration (Package E).
 *
 * Covers shared sender identity, primary/secondary transport routing, SMTP relay form + test,
 * Microsoft Graph (`Mail.Send`) form + egress preset + test, verified redacted audit copy, and
 * bounded encrypted message content retention. Secrets are strictly write-only.
 */
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, ExternalLink, ShieldCheck, XCircle } from "lucide-react";
import { Link } from "wouter";
import { errorMessage, safeError } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DateTime,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  PageHeader,
  RadioGroup,
  Select,
  Skeleton,
  StepUpCancelledError,
  Switch,
  Tabs,
  useStepUp,
  useToast,
} from "@/ui";
import { useMailClient, useMailTRPC } from "./api";
import {
  hasControlChars,
  isValidEmailAddress,
  isValidEntraGuid,
  isValidHostname,
  LAST_OUTCOME_LABELS,
  MAIL_SETTING_KEYS,
  providerBadgeMeta,
  readAuditCopySetting,
  readRetentionSettings,
  readRoutingSetting,
  readSenderSetting,
  SECONDARY_TRANSPORT_OPTIONS,
  TEST_OUTCOME_META,
  TRANSPORT_LABELS,
  type GraphConnectionTestResult,
  type GraphMailConfigView,
  type MailAuditCopySetting,
  type MailRoutingSetting,
  type MailSenderSetting,
  type MailSecondaryTransportKey,
  type MailTransportKey,
  type MailTransportTestResult,
  type ProviderState,
  type SmtpConfigView,
} from "./model";

function TransportBadge({ state, verified }: { state: ProviderState; verified: boolean }) {
  const meta = providerBadgeMeta(state, verified);
  const Icon =
    meta.tone === "success"
      ? CheckCircle2
      : meta.tone === "danger"
        ? XCircle
        : meta.tone === "warning"
          ? AlertTriangle
          : CircleDashed;
  return (
    <Badge tone={meta.tone} icon={<Icon className="size-3.5" aria-hidden="true" />}>
      {meta.label}
    </Badge>
  );
}

interface SmtpDraft {
  enabled: boolean;
  host: string;
  port: string;
  tlsMode: "starttls" | "implicit";
  username: string;
  password: string;
  clearPassword: boolean;
}

function initSmtpDraft(cfg: SmtpConfigView): SmtpDraft {
  return {
    enabled: cfg.enabled,
    host: cfg.host ?? "",
    port: cfg.port ? String(cfg.port) : "587",
    tlsMode: cfg.tlsMode ?? "starttls",
    username: cfg.username ?? "",
    password: "",
    clearPassword: false,
  };
}

interface GraphDraft {
  enabled: boolean;
  egressPresetEnabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  clearClientSecret: boolean;
  senderMailbox: string;
}

function initGraphDraft(cfg: GraphMailConfigView): GraphDraft {
  return {
    enabled: cfg.enabled,
    egressPresetEnabled: cfg.egressPresetEnabled,
    tenantId: cfg.tenantId ?? "",
    clientId: cfg.clientId ?? "",
    clientSecret: "",
    clearClientSecret: false,
    senderMailbox: cfg.senderMailbox ?? "",
  };
}

export default function EmailDeliveryPage() {
  const mailTrpc = useMailTRPC();
  const mailClient = useMailClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();

  const settingsQuery = useQuery(mailTrpc.platformSettingsList.queryOptions());
  const smtpQuery = useQuery(mailTrpc.smtpGet.queryOptions());
  const graphQuery = useQuery(mailTrpc.graphGet.queryOptions());
  const auditStatusQuery = useQuery(mailTrpc.auditCopyStatus.queryOptions());

  // Draft state per section so independent forms never overwrite unsaved edits in another section.
  const [senderRoutingDraft, setSenderRoutingDraft] = useState<{
    sender: MailSenderSetting;
    routing: MailRoutingSetting;
  } | null>(null);
  const [senderRoutingErrors, setSenderRoutingErrors] = useState<Record<string, string>>({});
  const [savingSenderRouting, setSavingSenderRouting] = useState(false);

  const [smtpDraft, setSmtpDraft] = useState<SmtpDraft | null>(null);
  const [smtpErrors, setSmtpErrors] = useState<Record<string, string>>({});
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [testingSmtp, setTestingSmtp] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState<MailTransportTestResult | null>(null);

  const [graphDraft, setGraphDraft] = useState<GraphDraft | null>(null);
  const [graphErrors, setGraphErrors] = useState<Record<string, string>>({});
  const [savingGraph, setSavingGraph] = useState(false);
  const [testingGraphConn, setTestingGraphConn] = useState(false);
  const [graphConnResult, setGraphConnResult] = useState<GraphConnectionTestResult | null>(null);
  const [testingGraph, setTestingGraph] = useState(false);
  const [graphTestResult, setGraphTestResult] = useState<MailTransportTestResult | null>(null);

  const [auditDraft, setAuditDraft] = useState<MailAuditCopySetting | null>(null);
  const [auditErrors, setAuditErrors] = useState<Record<string, string>>({});
  const [savingAudit, setSavingAudit] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);
  const [requestingCode, setRequestingCode] = useState(false);
  const [confirmingCode, setConfirmingCode] = useState(false);

  const [retentionDraft, setRetentionDraft] = useState<{
    retainContent: boolean;
    retentionDays: string;
  } | null>(null);
  const [retentionErrors, setRetentionErrors] = useState<Record<string, string>>({});
  const [savingRetention, setSavingRetention] = useState(false);

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: mailTrpc.platformSettingsList.queryKey() }),
      queryClient.invalidateQueries({ queryKey: mailTrpc.smtpGet.queryKey() }),
      queryClient.invalidateQueries({ queryKey: mailTrpc.graphGet.queryKey() }),
      queryClient.invalidateQueries({ queryKey: mailTrpc.auditCopyStatus.queryKey() }),
    ]);
  };

  const firstError =
    settingsQuery.error ?? smtpQuery.error ?? graphQuery.error ?? auditStatusQuery.error;
  const isPending =
    settingsQuery.isPending ||
    smtpQuery.isPending ||
    graphQuery.isPending ||
    auditStatusQuery.isPending;

  if (firstError) {
    return (
      <>
        <PageHeader
          title="E-mail delivery"
          description="Configure sender identity, SMTP and Microsoft Graph delivery transports, redacted audit copies, and stored message retention."
        />
        <ErrorState
          error={firstError}
          title="Could not load e-mail delivery settings"
          onRetry={() => {
            void settingsQuery.refetch();
            void smtpQuery.refetch();
            void graphQuery.refetch();
            void auditStatusQuery.refetch();
          }}
        />
      </>
    );
  }

  if (isPending || !settingsQuery.data || !smtpQuery.data || !graphQuery.data || !auditStatusQuery.data) {
    return (
      <>
        <PageHeader
          title="E-mail delivery"
          description="Configure sender identity, SMTP and Microsoft Graph delivery transports, redacted audit copies, and stored message retention."
        />
        <div aria-busy="true" className="space-y-6">
          <Skeleton lines={5} />
          <Skeleton lines={8} />
        </div>
      </>
    );
  }

  const settingRows = settingsQuery.data;
  const senderSetting = readSenderSetting(settingRows);
  const routingSetting = readRoutingSetting(settingRows);
  const auditSetting = readAuditCopySetting(settingRows);
  const retentionSetting = readRetentionSettings(settingRows);
  const smtpData = smtpQuery.data;
  const graphData = graphQuery.data;
  const auditVerified = auditStatusQuery.data.verified;

  const currentSenderRouting = senderRoutingDraft ?? {
    sender: senderSetting.value,
    routing: routingSetting.value,
  };
  const currentSmtp = smtpDraft ?? initSmtpDraft(smtpData);
  const currentGraph = graphDraft ?? initGraphDraft(graphData);
  const currentAudit = auditDraft ?? auditSetting.value;
  const currentRetention = retentionDraft ?? {
    retainContent: retentionSetting.retainContent,
    retentionDays: String(retentionSetting.retentionDays),
  };

  const primaryConfig = routingSetting.value.primary === "graph" ? graphData : smtpData;

  const handleSaveSenderRouting = async (event: FormEvent) => {
    event.preventDefault();
    const errs: Record<string, string> = {};
    const fromAddr = currentSenderRouting.sender.fromAddress.trim();
    const fromName = currentSenderRouting.sender.fromName.trim();
    const replyTo = currentSenderRouting.sender.replyToAddress.trim();

    if (fromAddr && !isValidEmailAddress(fromAddr)) {
      errs.fromAddress = "Enter a valid sender e-mail address without control characters, or leave empty for legacy SMTP fallback.";
    }
    if (fromName && (fromName.length > 120 || hasControlChars(fromName))) {
      errs.fromName = "Sender name must be 120 characters or fewer with no control characters.";
    }
    if (replyTo && !isValidEmailAddress(replyTo)) {
      errs.replyToAddress = "Enter a valid reply-to e-mail address, or leave it empty.";
    }
    if (
      currentSenderRouting.routing.secondary !== "none" &&
      currentSenderRouting.routing.secondary === currentSenderRouting.routing.primary
    ) {
      errs.secondary = "Secondary failover transport must differ from the primary transport, or be set to None.";
    }

    setSenderRoutingErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSavingSenderRouting(true);
    try {
      await stepUp.run(
        async () => {
          if (senderSetting.row) {
            await mailClient.updatePlatformSetting({
              key: MAIL_SETTING_KEYS.sender,
              expectedVersion: senderSetting.row.version,
              value: {
                fromAddress: fromAddr,
                fromName,
                replyToAddress: replyTo,
              },
            });
          }
          if (routingSetting.row) {
            await mailClient.updatePlatformSetting({
              key: MAIL_SETTING_KEYS.routing,
              expectedVersion: routingSetting.row.version,
              value: currentSenderRouting.routing,
            });
          }
        },
        { reason: "Updating outbound sender identity and mail routing requires verification." },
      );
      toast.show({ tone: "success", title: "Sender identity and routing saved" });
      setSenderRoutingDraft(null);
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      const safe = safeError(err);
      setSenderRoutingErrors({
        ...(safe?.fieldErrors ?? {}),
        form: errorMessage(err, "Sender identity and routing could not be saved."),
      });
    } finally {
      setSavingSenderRouting(false);
    }
  };

  const handleSaveSmtp = async (event: FormEvent) => {
    event.preventDefault();
    const errs: Record<string, string> = {};
    const host = currentSmtp.host.trim();
    const portNum = Number(currentSmtp.port.trim());
    const username = currentSmtp.username.trim();

    if (!isValidHostname(host)) {
      errs.host = "Enter a valid SMTP relay host name, for example smtp.example.com.";
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      errs.port = "Enter a port between 1 and 65535.";
    } else if (portNum === 25) {
      errs.port = "Port 25 is forbidden. Use port 587 (STARTTLS) or 465 (implicit TLS).";
    }
    if (!username || hasControlChars(username)) {
      errs.username = "Enter the relay username.";
    }

    setSmtpErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const password = currentSmtp.clearPassword
      ? null
      : currentSmtp.password
        ? currentSmtp.password
        : undefined;

    setSavingSmtp(true);
    try {
      await stepUp.run(
        () =>
          mailClient.updateSmtp({
            enabled: currentSmtp.enabled,
            host,
            port: portNum,
            tlsMode: currentSmtp.tlsMode,
            username,
            ...(password === undefined ? {} : { password }),
            fromAddress: senderSetting.value.fromAddress.trim() || (smtpData.fromAddress ?? ""),
            fromName: senderSetting.value.fromName.trim() || (smtpData.fromName ?? ""),
            ...(senderSetting.value.replyToAddress.trim()
              ? { replyToAddress: senderSetting.value.replyToAddress.trim() }
              : {}),
          }),
        { reason: "Saving SMTP relay settings requires verification." },
      );
      toast.show({ tone: "success", title: "SMTP relay settings saved" });
      setSmtpDraft(null);
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      const safe = safeError(err);
      setSmtpErrors({
        ...(safe?.fieldErrors ?? {}),
        form: errorMessage(err, "SMTP settings could not be saved."),
      });
    } finally {
      setSavingSmtp(false);
    }
  };

  const handleTestSmtp = async () => {
    setTestingSmtp(true);
    try {
      const result = await stepUp.run(() => mailClient.sendSmtpTest({}), {
        reason: "Sending an SMTP test message requires verification.",
      });
      setSmtpTestResult(result);
      toast.show({ tone: "info", title: "SMTP test completed" });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "SMTP test could not run",
        description: errorMessage(err),
      });
    } finally {
      setTestingSmtp(false);
    }
  };

  const handleSaveGraph = async (event: FormEvent) => {
    event.preventDefault();
    const errs: Record<string, string> = {};
    const tenantCheck = isValidEntraGuid(currentGraph.tenantId);
    if (!tenantCheck.ok) errs.tenantId = tenantCheck.message;

    const clientCheck = isValidEntraGuid(currentGraph.clientId);
    if (!clientCheck.ok) errs.clientId = "Enter a valid Application (client) ID GUID.";

    if (!isValidEmailAddress(currentGraph.senderMailbox)) {
      errs.senderMailbox = "Enter the licensed Exchange Online mailbox UPN or e-mail address used for Mail.Send.";
    }
    if (
      currentGraph.enabled &&
      !graphData.clientSecretConfigured &&
      !currentGraph.clientSecret &&
      !currentGraph.clearClientSecret
    ) {
      errs.clientSecret = "Enter a client secret before enabling Microsoft Graph mail.";
    }

    setGraphErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const clientSecret = currentGraph.clearClientSecret
      ? null
      : currentGraph.clientSecret
        ? currentGraph.clientSecret
        : undefined;

    setSavingGraph(true);
    try {
      await stepUp.run(
        () =>
          mailClient.updateGraph({
            enabled: currentGraph.enabled,
            enableEgressPreset: currentGraph.egressPresetEnabled,
            tenantId: currentGraph.tenantId.trim(),
            clientId: currentGraph.clientId.trim(),
            senderMailbox: currentGraph.senderMailbox.trim(),
            ...(clientSecret === undefined ? {} : { clientSecret }),
          }),
        { reason: "Saving Microsoft Graph mail settings requires verification." },
      );
      toast.show({ tone: "success", title: "Microsoft Graph mail settings saved" });
      setGraphDraft(null);
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      const safe = safeError(err);
      setGraphErrors({
        ...(safe?.fieldErrors ?? {}),
        form: errorMessage(err, "Microsoft Graph settings could not be saved."),
      });
    } finally {
      setSavingGraph(false);
    }
  };

  const handleTestGraphConnection = async () => {
    setTestingGraphConn(true);
    try {
      const result = await stepUp.run(() => mailClient.testGraphConnection({}), {
        reason: "Testing the Microsoft Graph connection requires verification.",
      });
      setGraphConnResult(result);
      toast.show({ tone: "info", title: "Microsoft Graph connection test completed" });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Microsoft Graph connection test could not run",
        description: errorMessage(err),
      });
    } finally {
      setTestingGraphConn(false);
    }
  };

  const handleTestGraph = async () => {
    setTestingGraph(true);
    try {
      const result = await stepUp.run(() => mailClient.sendGraphTest({}), {
        reason: "Sending a Microsoft Graph test message requires verification.",
      });
      setGraphTestResult(result);
      toast.show({ tone: "info", title: "Microsoft Graph test completed" });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Microsoft Graph test could not run",
        description: errorMessage(err),
      });
    } finally {
      setTestingGraph(false);
    }
  };

  const handleSaveAudit = async (event: FormEvent) => {
    event.preventDefault();
    const errs: Record<string, string> = {};
    const address = currentAudit.address.trim();

    if (currentAudit.enabled && !address) {
      errs.address = "Enter an audit mailbox address before enabling audit copies.";
    } else if (address && !isValidEmailAddress(address)) {
      errs.address = "Enter a valid audit mailbox e-mail address.";
    }

    setAuditErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSavingAudit(true);
    try {
      await stepUp.run(
        async () => {
          if (auditSetting.row) {
            await mailClient.updatePlatformSetting({
              key: MAIL_SETTING_KEYS.auditCopy,
              expectedVersion: auditSetting.row.version,
              value: {
                enabled: currentAudit.enabled,
                address,
              },
            });
          }
        },
        { reason: "Updating the audit mailbox setting requires verification." },
      );
      toast.show({ tone: "success", title: "Audit copy settings saved" });
      setAuditDraft(null);
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setAuditErrors({ form: errorMessage(err, "Audit copy settings could not be saved.") });
    } finally {
      setSavingAudit(false);
    }
  };

  const handleRequestAuditVerification = async () => {
    setVerificationError(null);
    setVerificationNotice(null);
    setRequestingCode(true);
    try {
      await stepUp.run(() => mailClient.requestAuditCopyVerification(), {
        reason: "Requesting an audit mailbox verification code requires verification.",
      });
      setVerificationNotice("A verification code has been queued for the saved audit mailbox address.");
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setVerificationError(errorMessage(err, "Could not send verification code."));
    } finally {
      setRequestingCode(false);
    }
  };

  const handleConfirmAuditVerification = async (event: FormEvent) => {
    event.preventDefault();
    setVerificationError(null);
    const trimmed = verificationCode.trim();
    if (!trimmed || hasControlChars(trimmed)) {
      setVerificationError("Enter the verification code sent to the audit mailbox.");
      return;
    }
    setConfirmingCode(true);
    try {
      await stepUp.run(() => mailClient.confirmAuditCopyVerification({ code: trimmed }), {
        reason: "Confirming the audit mailbox verification code requires verification.",
      });
      setVerificationCode("");
      setVerificationNotice("Audit mailbox verified.");
      toast.show({ tone: "success", title: "Audit mailbox verified" });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setVerificationError(errorMessage(err, "Verification code could not be confirmed."));
    } finally {
      setConfirmingCode(false);
    }
  };

  const handleSaveRetention = async (event: FormEvent) => {
    event.preventDefault();
    const errs: Record<string, string> = {};
    const days = Number(currentRetention.retentionDays.trim());
    if (!Number.isInteger(days) || days < 0 || days > 90) {
      errs.retentionDays = "Enter a whole number of days between 0 and 90.";
    }
    setRetentionErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSavingRetention(true);
    try {
      await stepUp.run(
        async () => {
          if (retentionSetting.retainRow) {
            await mailClient.updatePlatformSetting({
              key: MAIL_SETTING_KEYS.retainContent,
              expectedVersion: retentionSetting.retainRow.version,
              value: currentRetention.retainContent,
            });
          }
          if (retentionSetting.daysRow) {
            await mailClient.updatePlatformSetting({
              key: MAIL_SETTING_KEYS.retentionDays,
              expectedVersion: retentionSetting.daysRow.version,
              value: days,
            });
          }
        },
        { reason: "Updating stored message content retention requires verification." },
      );
      toast.show({ tone: "success", title: "Content retention settings saved" });
      setRetentionDraft(null);
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setRetentionErrors({ form: errorMessage(err, "Retention settings could not be saved.") });
    } finally {
      setSavingRetention(false);
    }
  };

  return (
    <>
      <PageHeader
        title="E-mail delivery"
        description="Configure shared sender identity, primary and failover transports (SMTP and Microsoft Graph), verified redacted audit copies, and bounded message content retention."
        meta={<TransportBadge state={primaryConfig.state} verified={primaryConfig.verified} />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <Link href="/admin/mail">Mail log</Link>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href="/admin/email-templates">E-mail templates</Link>
            </Button>
          </div>
        }
      />

      <div className="flex min-w-0 flex-col gap-6">
        <Callout tone="info" title="Duplicate-safe failover and secret redaction">
          <p>
            The secondary transport is used only when the primary transport definitely did not accept a message (not
            configured, connection refused, authentication failed, or explicit rejection). Ambiguous outcomes remain{" "}
            <strong>Unknown outcome</strong> and never fail over or auto-replay. Single-use links and codes are redacted
            before rendering audit copies and stored content.
          </p>
        </Callout>

        {/* Section 1: Shared sender identity & primary/secondary routing */}
        <Card
          as="section"
          title="Sender identity and delivery routing"
          description="Shared outbound From and Reply-To headers used across SMTP and Microsoft Graph, plus primary and failover transport order."
        >
          <form
            noValidate
            onSubmit={(event) => void handleSaveSenderRouting(event)}
            className="flex min-w-0 flex-col gap-5"
            aria-label="Sender identity and delivery routing"
          >
            {senderRoutingErrors.form ? (
              <Callout tone="danger" live="assertive">
                {senderRoutingErrors.form}
              </Callout>
            ) : null}

            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field
                label="From address"
                hint="Shared outbound address. If left blank, SMTP falls back to its legacy relay sender."
                error={senderRoutingErrors.fromAddress}
              >
                <Input
                  type="email"
                  value={currentSenderRouting.sender.fromAddress}
                  onChange={(e) =>
                    setSenderRoutingDraft({
                      ...currentSenderRouting,
                      sender: { ...currentSenderRouting.sender, fromAddress: e.target.value },
                    })
                  }
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={254}
                />
              </Field>

              <Field
                label="From name"
                hint="Display name recipients see, for example ReadyPackets Portal."
                error={senderRoutingErrors.fromName}
              >
                <Input
                  value={currentSenderRouting.sender.fromName}
                  onChange={(e) =>
                    setSenderRoutingDraft({
                      ...currentSenderRouting,
                      sender: { ...currentSenderRouting.sender, fromName: e.target.value },
                    })
                  }
                  autoComplete="off"
                  maxLength={120}
                />
              </Field>

              <Field
                label="Reply-to address"
                hint="Optional address for recipient replies."
                error={senderRoutingErrors.replyToAddress}
              >
                <Input
                  type="email"
                  value={currentSenderRouting.sender.replyToAddress}
                  onChange={(e) =>
                    setSenderRoutingDraft({
                      ...currentSenderRouting,
                      sender: { ...currentSenderRouting.sender, replyToAddress: e.target.value },
                    })
                  }
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={254}
                />
              </Field>
            </div>

            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
              <RadioGroup
                legend="Primary delivery transport"
                variant="cards"
                value={currentSenderRouting.routing.primary}
                onValueChange={(val) => {
                  const nextPrimary = val as MailTransportKey;
                  setSenderRoutingDraft({
                    ...currentSenderRouting,
                    routing: {
                      primary: nextPrimary,
                      secondary:
                        currentSenderRouting.routing.secondary === nextPrimary
                          ? "none"
                          : currentSenderRouting.routing.secondary,
                    },
                  });
                }}
                options={[
                  {
                    value: "smtp",
                    label: "SMTP relay",
                    description: `TLS-enforced mail relay (${providerBadgeMeta(smtpData.state, smtpData.verified).label}).`,
                  },
                  {
                    value: "graph",
                    label: "Microsoft Graph",
                    description: `Exchange Online Mail.Send (${providerBadgeMeta(graphData.state, graphData.verified).label}).`,
                  },
                ]}
              />

              <Field
                label="Secondary failover transport"
                hint="Tried only when the primary transport definitely refused or was not configured."
                error={senderRoutingErrors.secondary}
              >
                <Select
                  value={currentSenderRouting.routing.secondary}
                  onChange={(e) =>
                    setSenderRoutingDraft({
                      ...currentSenderRouting,
                      routing: {
                        ...currentSenderRouting.routing,
                        secondary: e.target.value as MailSecondaryTransportKey,
                      },
                    })
                  }
                  options={SECONDARY_TRANSPORT_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                    disabled: opt.value === currentSenderRouting.routing.primary,
                  }))}
                />
              </Field>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={savingSenderRouting}>
                Save sender and routing
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!senderRoutingDraft}
                onClick={() => {
                  setSenderRoutingDraft(null);
                  setSenderRoutingErrors({});
                }}
              >
                Discard changes
              </Button>
            </div>
          </form>
        </Card>

        {/* Section 2: Transport configuration & test tabs */}
        <Tabs
          label="Mail delivery transports"
          defaultValue="smtp"
          items={[
            {
              value: "smtp",
              label: TRANSPORT_LABELS.smtp,
              badge: <TransportBadge state={smtpData.state} verified={smtpData.verified} />,
              content: (
                <div className="mt-4 grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
                  <Card
                    as="section"
                    className="min-w-0 lg:col-span-2"
                    title="SMTP relay configuration"
                    description="Only TLS connections are allowed (STARTTLS or implicit TLS). Plaintext port 25 is forbidden."
                  >
                    <form
                      noValidate
                      onSubmit={(event) => void handleSaveSmtp(event)}
                      className="flex min-w-0 flex-col gap-4"
                      aria-label="SMTP relay configuration"
                    >
                      {smtpErrors.form ? (
                        <Callout tone="danger" live="assertive">
                          {smtpErrors.form}
                        </Callout>
                      ) : null}

                      <Switch
                        label="Enable SMTP relay transport"
                        description="Allow the mail worker to send through this TLS relay when selected as primary or secondary."
                        checked={currentSmtp.enabled}
                        onCheckedChange={(checked) => setSmtpDraft({ ...currentSmtp, enabled: checked })}
                      />

                      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3">
                        <Field label="SMTP host" required error={smtpErrors.host} className="sm:col-span-2">
                          <Input
                            value={currentSmtp.host}
                            onChange={(e) => setSmtpDraft({ ...currentSmtp, host: e.target.value })}
                            autoComplete="off"
                            spellCheck={false}
                            inputMode="url"
                            maxLength={253}
                          />
                        </Field>
                        <Field label="SMTP port" required error={smtpErrors.port}>
                          <Input
                            value={currentSmtp.port}
                            onChange={(e) => setSmtpDraft({ ...currentSmtp, port: e.target.value })}
                            inputMode="numeric"
                            autoComplete="off"
                            maxLength={5}
                          />
                        </Field>
                      </div>

                      <RadioGroup
                        legend="SMTP TLS mode"
                        value={currentSmtp.tlsMode}
                        onValueChange={(val) =>
                          setSmtpDraft({ ...currentSmtp, tlsMode: val as "starttls" | "implicit" })
                        }
                        options={[
                          {
                            value: "starttls",
                            label: "STARTTLS (port 587)",
                            description: "Upgrades to TLS before authentication; plaintext fallback is refused.",
                          },
                          {
                            value: "implicit",
                            label: "Implicit TLS (port 465)",
                            description: "TLS handshake from the first byte.",
                          },
                        ]}
                      />

                      <Field label="SMTP username" required error={smtpErrors.username}>
                        <Input
                          value={currentSmtp.username}
                          onChange={(e) => setSmtpDraft({ ...currentSmtp, username: e.target.value })}
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={256}
                        />
                      </Field>

                      <Field
                        label="SMTP password"
                        hint={
                          smtpData.passwordConfigured
                            ? "A password is stored encrypted and never echoed. Leave empty to keep it, or enter a new value to rotate."
                            : "No password is stored yet. Enter one if your relay requires authentication."
                        }
                      >
                        <Input
                          type="password"
                          value={currentSmtp.password}
                          disabled={currentSmtp.clearPassword}
                          onChange={(e) => setSmtpDraft({ ...currentSmtp, password: e.target.value })}
                          autoComplete="new-password"
                          maxLength={1024}
                        />
                      </Field>

                      {smtpData.passwordConfigured ? (
                        <Checkbox
                          label="Remove the stored SMTP password"
                          checked={currentSmtp.clearPassword}
                          onCheckedChange={(checked) =>
                            setSmtpDraft({ ...currentSmtp, clearPassword: checked, password: "" })
                          }
                        />
                      ) : null}

                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" loading={savingSmtp}>
                          Save SMTP settings
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={!smtpDraft}
                          onClick={() => {
                            setSmtpDraft(null);
                            setSmtpErrors({});
                          }}
                        >
                          Discard SMTP changes
                        </Button>
                      </div>
                    </form>
                  </Card>

                  <div className="flex min-w-0 flex-col gap-6">
                    <Card as="section" title="SMTP status">
                      <KeyValueList
                        columns={1}
                        items={[
                          { label: "Status", value: <TransportBadge state={smtpData.state} verified={smtpData.verified} /> },
                          {
                            label: "Password",
                            value: smtpData.passwordConfigured
                              ? `Stored${smtpData.passwordLast4 ? ` (…${smtpData.passwordLast4})` : " (encrypted)"}`
                              : "Not stored",
                          },
                          {
                            label: "Last check",
                            value: smtpData.lastCheckedAt ? <DateTime value={smtpData.lastCheckedAt} /> : "Never checked",
                          },
                          {
                            label: "Last outcome",
                            value: smtpData.lastOutcome ? LAST_OUTCOME_LABELS[smtpData.lastOutcome] : "No test yet",
                          },
                          { label: "Summary", value: smtpData.summary || "—" },
                        ]}
                      />
                    </Card>

                    <Card
                      as="section"
                      title="Test SMTP relay"
                      description="Sends one test message to your signed-in administrator e-mail address using the saved SMTP settings."
                    >
                      <div className="flex flex-col gap-3">
                        <Button
                          type="button"
                          variant="secondary"
                          loading={testingSmtp}
                          disabled={!smtpData.configured}
                          onClick={() => void handleTestSmtp()}
                        >
                          Send SMTP test to me
                        </Button>
                        {!smtpData.configured ? (
                          <p className="text-sm text-muted">Save complete SMTP settings before running a test.</p>
                        ) : null}
                        {smtpTestResult ? (
                          <Callout
                            tone={TEST_OUTCOME_META[smtpTestResult.outcome].tone}
                            title={TEST_OUTCOME_META[smtpTestResult.outcome].title}
                            live="polite"
                          >
                            <p>{smtpTestResult.safeMessage}</p>
                            <p className="mt-1 text-xs">
                              Checked <DateTime value={smtpTestResult.checkedAt} />
                            </p>
                          </Callout>
                        ) : null}
                      </div>
                    </Card>
                  </div>
                </div>
              ),
            },
            {
              value: "graph",
              label: TRANSPORT_LABELS.graph,
              badge: <TransportBadge state={graphData.state} verified={graphData.verified} />,
              content: (
                <div className="mt-4 grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
                  <Card
                    as="section"
                    className="min-w-0 lg:col-span-2"
                    title="Microsoft Graph mail (Mail.Send)"
                    description="Sends mail via Microsoft Graph client-credentials flow pinned to a single Entra tenant and outbound allowlist rule."
                  >
                    <form
                      noValidate
                      onSubmit={(event) => void handleSaveGraph(event)}
                      className="flex min-w-0 flex-col gap-4"
                      aria-label="Microsoft Graph mail configuration"
                    >
                      {graphErrors.form ? (
                        <Callout tone="danger" live="assertive">
                          {graphErrors.form}
                        </Callout>
                      ) : null}

                      <Callout tone="info" title="Restricting Mail.Send to one mailbox">
                        <p>
                          {graphData.mailboxRestrictionNote ||
                            "Grant application permission Mail.Send in Microsoft Entra ID and scope the service principal to the single sender mailbox with Exchange Online Role-Based Access Control for Applications (New-ManagementScope / New-ServicePrincipal)."}
                        </p>
                      </Callout>

                      <Switch
                        label="Enable Microsoft Graph mail transport"
                        description="Allow the mail worker to send via POST /users/{sender}/sendMail when selected as primary or secondary."
                        checked={currentGraph.enabled}
                        onCheckedChange={(checked) => setGraphDraft({ ...currentGraph, enabled: checked })}
                      />

                      <Switch
                        label="Allow outbound Microsoft Graph connections"
                        description="Enables the pinned HTTPS egress allowlist preset for login.microsoftonline.com and graph.microsoft.com."
                        checked={currentGraph.egressPresetEnabled}
                        onCheckedChange={(checked) =>
                          setGraphDraft({ ...currentGraph, egressPresetEnabled: checked })
                        }
                      />

                      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                        <Field
                          label="Directory (tenant) ID"
                          required
                          hint="Single-tenant Entra GUID. Aliases like common or organizations are refused."
                          error={graphErrors.tenantId}
                        >
                          <Input
                            value={currentGraph.tenantId}
                            onChange={(e) => setGraphDraft({ ...currentGraph, tenantId: e.target.value })}
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={64}
                          />
                        </Field>

                        <Field
                          label="Application (client) ID"
                          required
                          hint="App registration GUID in your Microsoft Entra tenant."
                          error={graphErrors.clientId}
                        >
                          <Input
                            value={currentGraph.clientId}
                            onChange={(e) => setGraphDraft({ ...currentGraph, clientId: e.target.value })}
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={64}
                          />
                        </Field>
                      </div>

                      <Field
                        label="Sender mailbox (UPN or address)"
                        required
                        hint="Licensed Exchange Online mailbox invoked by POST /users/{sender}/sendMail."
                        error={graphErrors.senderMailbox}
                      >
                        <Input
                          type="email"
                          value={currentGraph.senderMailbox}
                          onChange={(e) => setGraphDraft({ ...currentGraph, senderMailbox: e.target.value })}
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={254}
                        />
                      </Field>

                      <Field
                        label="Client secret"
                        error={graphErrors.clientSecret}
                        hint={
                          graphData.clientSecretConfigured
                            ? `Encrypted secret stored${graphData.clientSecretLast4 ? ` (ends in …${graphData.clientSecretLast4})` : ""}. Leave empty to keep it, or enter a new secret value to rotate.`
                            : "Paste the client secret value (not the secret ID) from Certificates & secrets."
                        }
                      >
                        <Input
                          type="password"
                          value={currentGraph.clientSecret}
                          disabled={currentGraph.clearClientSecret}
                          onChange={(e) => setGraphDraft({ ...currentGraph, clientSecret: e.target.value })}
                          autoComplete="new-password"
                          maxLength={2048}
                        />
                      </Field>

                      {graphData.clientSecretConfigured ? (
                        <Checkbox
                          label="Remove the stored Microsoft Graph client secret"
                          checked={currentGraph.clearClientSecret}
                          onCheckedChange={(checked) =>
                            setGraphDraft({
                              ...currentGraph,
                              clearClientSecret: checked,
                              clientSecret: "",
                            })
                          }
                        />
                      ) : null}

                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" loading={savingGraph}>
                          Save Microsoft Graph settings
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={!graphDraft}
                          onClick={() => {
                            setGraphDraft(null);
                            setGraphErrors({});
                          }}
                        >
                          Discard Graph changes
                        </Button>
                      </div>
                    </form>
                  </Card>

                  <div className="flex min-w-0 flex-col gap-6">
                    <Card as="section" title="Microsoft Graph status">
                      <KeyValueList
                        columns={1}
                        items={[
                          { label: "Status", value: <TransportBadge state={graphData.state} verified={graphData.verified} /> },
                          {
                            label: "Outbound allowlist",
                            value: (graphData.egressReady ?? graphData.egressPresetEnabled) ? (
                              <Badge tone="success">Allowed</Badge>
                            ) : (
                              <Badge tone="warning">Blocked until enabled</Badge>
                            ),
                          },
                          {
                            label: "Client secret",
                            value: graphData.clientSecretConfigured
                              ? `Stored${graphData.clientSecretLast4 ? ` (…${graphData.clientSecretLast4})` : ""}`
                              : "Not stored",
                          },
                          {
                            label: "Last check",
                            value: graphData.lastCheckedAt ? (
                              <DateTime value={graphData.lastCheckedAt} />
                            ) : (
                              "Never checked"
                            ),
                          },
                          {
                            label: "Last outcome",
                            value: graphData.lastOutcome ? LAST_OUTCOME_LABELS[graphData.lastOutcome] : "No test yet",
                          },
                          { label: "Summary", value: graphData.summary || "—" },
                        ]}
                      />
                      <div className="mt-3">
                        <Link
                          href="/admin/integrations/egress"
                          className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-action underline-offset-4 hover:underline"
                        >
                          Review outbound allowlist rules
                          <ExternalLink className="size-3.5" aria-hidden="true" />
                        </Link>
                      </div>
                    </Card>

                    <Card
                      as="section"
                      title="Test Microsoft Graph mail"
                      description="Sends one test message to your signed-in administrator e-mail address through Microsoft Graph."
                    >
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            loading={testingGraphConn}
                            disabled={!graphData.configured}
                            onClick={() => void handleTestGraphConnection()}
                          >
                            Test Graph connection
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            loading={testingGraph}
                            disabled={!graphData.configured}
                            onClick={() => void handleTestGraph()}
                          >
                            Send Graph test to me
                          </Button>
                        </div>
                        {!graphData.configured ? (
                          <p className="text-sm text-muted">
                            Save complete Microsoft Graph credentials and enable the egress preset before testing.
                          </p>
                        ) : null}
                        {graphConnResult ? (
                          <Callout
                            tone={graphConnResult.outcome === "succeeded" ? "success" : "danger"}
                            title={
                              graphConnResult.outcome === "succeeded"
                                ? "Microsoft Graph token and connection verified"
                                : "Microsoft Graph connection check failed"
                            }
                            live="polite"
                          >
                            <p>{graphConnResult.safeMessage}</p>
                            <p className="mt-1 text-xs">
                              Checked <DateTime value={graphConnResult.checkedAt} />
                            </p>
                          </Callout>
                        ) : null}
                        {graphTestResult ? (
                          <Callout
                            tone={TEST_OUTCOME_META[graphTestResult.outcome].tone}
                            title={TEST_OUTCOME_META[graphTestResult.outcome].title}
                            live="polite"
                          >
                            <p>{graphTestResult.safeMessage}</p>
                            <p className="mt-1 text-xs">
                              Checked <DateTime value={graphTestResult.checkedAt} />
                            </p>
                          </Callout>
                        ) : null}
                      </div>
                    </Card>
                  </div>
                </div>
              ),
            },
          ]}
        />

        {/* Section 3: Audit copy & Stored content retention */}
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
          <Card
            as="section"
            title="Audit mailbox copy"
            description="Sends a separate redacted copy of outbound messages to a verified compliance mailbox. Single-use reset, invitation, activation, and verification secrets are replaced before rendering."
            actions={
              auditSetting.value.address ? (
                auditVerified ? (
                  <Badge tone="success" icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}>
                    Verified mailbox
                  </Badge>
                ) : (
                  <Badge tone="warning" icon={<AlertTriangle className="size-3.5" aria-hidden="true" />}>
                    Verification required
                  </Badge>
                )
              ) : (
                <Badge tone="neutral">Not configured</Badge>
              )
            }
          >
            <div className="flex min-w-0 flex-col gap-5">
              <form
                noValidate
                onSubmit={(event) => void handleSaveAudit(event)}
                className="flex min-w-0 flex-col gap-4"
                aria-label="Audit mailbox copy settings"
              >
                {auditErrors.form ? (
                  <Callout tone="danger" live="assertive">
                    {auditErrors.form}
                  </Callout>
                ) : null}

                <Switch
                  label="Enable redacted audit copy"
                  description="Each copy is recorded as its own delivery attempt. No copies are sent until the address below is verified."
                  checked={currentAudit.enabled}
                  onCheckedChange={(checked) => setAuditDraft({ ...currentAudit, enabled: checked })}
                />

                <Field
                  label="Audit mailbox address"
                  hint="Compliance archive mailbox controlled by your organization."
                  error={auditErrors.address}
                >
                  <Input
                    type="email"
                    value={currentAudit.address}
                    onChange={(e) => setAuditDraft({ ...currentAudit, address: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={254}
                  />
                </Field>

                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={savingAudit}>
                    Save audit copy settings
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!auditDraft}
                    onClick={() => {
                      setAuditDraft(null);
                      setAuditErrors({});
                    }}
                  >
                    Discard changes
                  </Button>
                </div>
              </form>

              {auditSetting.value.address && !auditVerified ? (
                <div className="border-t border-line pt-4">
                  <Callout tone="warning" title="Verify the saved audit mailbox before copies begin">
                    <p>
                      Audit copies remain paused until you confirm control of{" "}
                      <span className="font-mono break-all">{auditSetting.value.address}</span>.
                    </p>
                  </Callout>

                  {verificationNotice ? (
                    <Callout tone="info" live="polite" className="mt-3">
                      {verificationNotice}
                    </Callout>
                  ) : null}
                  {verificationError ? (
                    <Callout tone="danger" live="assertive" className="mt-3">
                      {verificationError}
                    </Callout>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      loading={requestingCode}
                      onClick={() => void handleRequestAuditVerification()}
                    >
                      Send verification code
                    </Button>
                  </div>

                  <form
                    noValidate
                    onSubmit={(event) => void handleConfirmAuditVerification(event)}
                    className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
                    aria-label="Confirm audit mailbox verification code"
                  >
                    <Field label="Verification code" className="min-w-0 flex-1">
                      <Input
                        value={verificationCode}
                        onChange={(e) => setVerificationCode(e.target.value)}
                        autoComplete="one-time-code"
                        spellCheck={false}
                        maxLength={64}
                      />
                    </Field>
                    <Button type="submit" size="md" loading={confirmingCode}>
                      Confirm verification code
                    </Button>
                  </form>
                </div>
              ) : null}
            </div>
          </Card>

          <Card
            as="section"
            title="Stored message content retention"
            description="Optionally retain encrypted, secret-redacted message bodies so administrators can inspect sent messages in the Mail log after fresh MFA verification."
            actions={
              retentionSetting.retainContent && retentionSetting.retentionDays > 0 ? (
                <Badge tone="info">Retained ({retentionSetting.retentionDays} days)</Badge>
              ) : (
                <Badge tone="neutral">Disabled</Badge>
              )
            }
          >
            <form
              noValidate
              onSubmit={(event) => void handleSaveRetention(event)}
              className="flex min-w-0 flex-col gap-4"
              aria-label="Stored message content retention"
            >
              {retentionErrors.form ? (
                <Callout tone="danger" live="assertive">
                  {retentionErrors.form}
                </Callout>
              ) : null}

              <Switch
                label="Retain redacted message content"
                description="Off by default. Switching off immediately hides stored message bodies and purges expired payloads in the background. Every view in the Mail log requires step-up MFA and is audited."
                checked={currentRetention.retainContent}
                onCheckedChange={(checked) =>
                  setRetentionDraft({ ...currentRetention, retainContent: checked })
                }
              />

              <Field
                label="Retention window (days)"
                hint="Whole days from 0 to 90 (default 30). Setting 0 disables retention."
                error={retentionErrors.retentionDays}
              >
                <Input
                  value={currentRetention.retentionDays}
                  onChange={(e) =>
                    setRetentionDraft({ ...currentRetention, retentionDays: e.target.value })
                  }
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={2}
                />
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={savingRetention}>
                  Save retention settings
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!retentionDraft}
                  onClick={() => {
                    setRetentionDraft(null);
                    setRetentionErrors({});
                  }}
                >
                  Discard changes
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
