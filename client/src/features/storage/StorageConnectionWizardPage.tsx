/**
 * Multi-step wizard for adding (/admin/storage/new) or editing (/admin/storage/:publicId/edit)
 * an external storage connection across all 9 provider options using each provider's own field names.
 */
import { useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CopyButton,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  PageHeader,
  RadioGroup,
  Select,
  Skeleton,
  StepUpCancelledError,
  Wizard,
  useStepUp,
  useToast,
} from "@/ui";
import { errorMessage } from "@/lib/trpc";
import { useStorageApi, useStorageDirectClient, type OAuthProvider } from "./api";
import {
  buildConfigFromDraft,
  buildCredentialsFromDraft,
  configsEqual,
  createEmptyWizardDraft,
  describeConnectionStatus,
  draftFromConnection,
  PROVIDER_CHOICES,
  STORAGE_TEST_CODE_LABELS,
  validateWizardStep2,
  type ProviderChoiceId,
  type SharePointDriveItem,
  type SharePointFolderItem,
  type StorageConnectionView,
  type StorageTestResult,
  type WizardFormDraft,
} from "./model";

const WIZARD_STEPS = [
  { id: "provider", label: "Choose provider" },
  { id: "credentials", label: "Configure credentials" },
  { id: "verify", label: "Verify & enable" },
];

export function StorageConnectionWizardPage() {
  const params = useParams<{ publicId?: string }>();
  const publicId = params.publicId;
  const isEditRoute = Boolean(publicId);
  const [, navigate] = useLocation();
  const api = useStorageApi();
  const storageClient = useStorageDirectClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();

  const existingQuery = useQuery({
    ...api.connectionGet.queryOptions({ publicId: publicId ?? "" }),
    enabled: isEditRoute,
  });

  const [step, setStep] = useState<string>(isEditRoute ? "credentials" : "provider");
  const [completed, setCompleted] = useState<string[]>(isEditRoute ? ["provider"] : []);
  const [draftOverride, setDraftOverride] = useState<WizardFormDraft | null>(null);
  const [savedConn, setSavedConn] = useState<StorageConnectionView | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Kept only in React component state during this wizard session so SharePoint/OneDrive
  // discovery updates can re-bind credentials when updating config.
  const [transientGraphSecret, setTransientGraphSecret] = useState<string>("");

  // SharePoint / OneDrive discovery state
  const [discoveredSiteLabel, setDiscoveredSiteLabel] = useState<string>("");
  const [drives, setDrives] = useState<SharePointDriveItem[]>([]);
  const [folders, setFolders] = useState<SharePointFolderItem[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [savingDiscovery, setSavingDiscovery] = useState(false);

  // Test state
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<StorageTestResult | null>(null);
  const [enabling, setEnabling] = useState(false);

  const baseDraft = existingQuery.data
    ? draftFromConnection(existingQuery.data)
    : createEmptyWizardDraft("aws_s3");
  const draft = draftOverride ?? baseDraft;

  const activeChoice =
    PROVIDER_CHOICES.find((c) => c.id === draft.choiceId) ?? PROVIDER_CHOICES[0]!;

  const oauthProvider: OAuthProvider | null =
    activeChoice.kind === "dropbox" || activeChoice.kind === "google_drive"
      ? activeChoice.kind
      : null;

  const redirectUriQuery = useQuery({
    queryKey: ["storage.oauth.redirectUri", oauthProvider] as const,
    enabled: oauthProvider !== null,
    queryFn: async () => {
      if (!oauthProvider) return "";
      try {
        const res = await storageClient.getOAuthRedirectUri(oauthProvider);
        return res.redirectUri;
      } catch {
        return `${window.location.origin}/api/storage/oauth/callback/${oauthProvider}`;
      }
    },
  });
  const redirectUri = oauthProvider ? (redirectUriQuery.data ?? "") : "";

  if (isEditRoute && existingQuery.error) {
    return (
      <>
        <PageHeader title="Edit storage connection" />
        <ErrorState
          error={existingQuery.error}
          title="Could not load storage connection"
          onRetry={() => {
            void existingQuery.refetch();
          }}
        />
      </>
    );
  }

  if (isEditRoute && (existingQuery.isPending || !existingQuery.data)) {
    return (
      <>
        <PageHeader title="Edit storage connection" />
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading storage connection">
          <Skeleton className="h-56 w-full" />
        </div>
      </>
    );
  }

  const activeConnection = savedConn ?? existingQuery.data ?? null;

  const updateDraft = (patch: Partial<WizardFormDraft>) => {
    setDraftOverride((prev) => ({ ...(prev ?? baseDraft), ...patch }));
  };

  const handleSaveStep2 = async () => {
    const validationErrors = validateWizardStep2(draft, activeConnection);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    const nextConfig = buildConfigFromDraft(draft);
    const creds = buildCredentialsFromDraft(draft);
    setBusy(true);
    try {
      let updated: StorageConnectionView;
      if (!activeConnection) {
        updated = await stepUp.run(
          () =>
            storageClient.createConnection({
              kind: activeChoice.kind,
              name: draft.name.trim(),
              config: nextConfig,
              ...(creds && creds !== null ? { credentials: creds } : {}),
            }),
          { reason: "Creating a storage connection requires verification." },
        );
      } else {
        const configChanged = !configsEqual(activeConnection.config, nextConfig);
        updated = await stepUp.run(
          () =>
            storageClient.updateConnection({
              publicId: activeConnection.publicId,
              expectedVersion: activeConnection.version,
              name: draft.name.trim(),
              ...(configChanged ? { config: nextConfig } : {}),
              ...(creds === undefined ? {} : { credentials: creds }),
            }),
          { reason: "Updating a storage connection requires verification." },
        );
      }

      if (draft.graphClientSecret.trim()) {
        setTransientGraphSecret(draft.graphClientSecret.trim());
      }
      setSavedConn(updated);
      updateDraft({
        s3SecretAccessKey: "",
        s3SessionToken: "",
        azureAccountKey: "",
        azureSasToken: "",
        oauthClientSecret: "",
        graphClientSecret: "",
        clearCredentials: false,
      });
      await queryClient.invalidateQueries({ queryKey: api.connectionsList.queryKey() });
      setCompleted((prev) => Array.from(new Set([...prev, "provider", "credentials"])));
      setStep("verify");
      toast.show({ tone: "success", title: "Storage connection saved" });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not save storage connection",
        description: errorMessage(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDiscoverGraph = async () => {
    if (!activeConnection) return;
    setDiscovering(true);
    try {
      if (activeConnection.kind === "sharepoint") {
        const site = await stepUp.run(
          () =>
            storageClient.discoverSite({
              connectionPublicId: activeConnection.publicId,
              expectedVersion: activeConnection.version,
              siteUrl: draft.sharepointSiteUrl.trim(),
            }),
          { reason: "Discovering a SharePoint site requires verification." },
        );
        setDiscoveredSiteLabel(`${site.displayName} (${site.webUrl})`);
        const driveRes = await storageClient.listDrives({
          connectionPublicId: activeConnection.publicId,
          expectedVersion: activeConnection.version,
          siteId: site.siteId,
        });
        setDrives(driveRes.drives);
        const firstDrive = driveRes.drives[0];
        updateDraft({
          sharepointSiteId: site.siteId,
          graphDriveId: firstDrive?.driveId ?? "",
          graphDriveName: firstDrive?.name ?? "",
        });
        if (firstDrive) {
          const folderRes = await storageClient.listFolders({
            connectionPublicId: activeConnection.publicId,
            expectedVersion: activeConnection.version,
            kind: "sharepoint",
            driveId: firstDrive.driveId,
          });
          setFolders(folderRes.folders);
        }
        toast.show({ tone: "success", title: "SharePoint site and document libraries discovered" });
      } else if (activeConnection.kind === "onedrive") {
        const resolved = await stepUp.run(
          () =>
            storageClient.resolveOneDrive({
              connectionPublicId: activeConnection.publicId,
              expectedVersion: activeConnection.version,
              userPrincipalName: draft.onedriveUpn.trim(),
            }),
          { reason: "Resolving a OneDrive for Business account requires verification." },
        );
        updateDraft({
          graphDriveId: resolved.driveId,
          graphDriveName: resolved.driveName,
        });
        const folderRes = await storageClient.listFolders({
          connectionPublicId: activeConnection.publicId,
          expectedVersion: activeConnection.version,
          kind: "onedrive",
          driveId: resolved.driveId,
        });
        setFolders(folderRes.folders);
        toast.show({ tone: "success", title: `Resolved drive: ${resolved.driveName}` });
      }
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Microsoft Graph discovery failed",
        description: errorMessage(err),
      });
    } finally {
      setDiscovering(false);
    }
  };

  const handleSaveDiscoverySelection = async () => {
    if (!activeConnection) return;
    const secretForRebind = draft.graphClientSecret.trim() || transientGraphSecret;
    if (!secretForRebind) {
      toast.show({
        tone: "warning",
        title: "Client secret required to bind discovered library",
        description: "Enter your Entra Client secret below to bind the newly selected document library.",
      });
      return;
    }
    setSavingDiscovery(true);
    try {
      const nextConfig = buildConfigFromDraft(draft);
      const updated = await stepUp.run(
        () =>
          storageClient.updateConnection({
            publicId: activeConnection.publicId,
            expectedVersion: activeConnection.version,
            config: nextConfig,
            credentials: { clientSecret: secretForRebind },
          }),
        { reason: "Binding the discovered Microsoft 365 library requires verification." },
      );
      setSavedConn(updated);
      updateDraft({ graphClientSecret: "" });
      await queryClient.invalidateQueries({ queryKey: api.connectionsList.queryKey() });
      toast.show({ tone: "success", title: "Document library selection saved" });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not save library selection",
        description: errorMessage(err),
      });
    } finally {
      setSavingDiscovery(false);
    }
  };

  const handleStartOAuthFromWizard = async () => {
    if (!activeConnection || (activeConnection.kind !== "dropbox" && activeConnection.kind !== "google_drive")) return;
    const provider: OAuthProvider = activeConnection.kind;
    setBusy(true);
    try {
      const { authorizeUrl } = await stepUp.run(
        () =>
          storageClient.startOAuth({
            provider,
            publicId: activeConnection.publicId,
            expectedVersion: activeConnection.version,
          }),
        { reason: "Starting OAuth consent requires verification." },
      );
      window.location.assign(authorizeUrl);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not start OAuth authorization",
        description: errorMessage(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRunTest = async () => {
    if (!activeConnection) return;
    setTesting(true);
    try {
      const res = await stepUp.run(
        () => storageClient.testConnection({ publicId: activeConnection.publicId }),
        { reason: "Testing a storage connection requires verification." },
      );
      setTestOutcome(res);
      setSavedConn((prev) =>
        prev
          ? {
              ...prev,
              lastTest: { ...res, checkedAt: new Date().toISOString() },
            }
          : prev,
      );
      await queryClient.invalidateQueries({ queryKey: api.connectionsList.queryKey() });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Connection test could not run",
        description: errorMessage(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleEnableNow = async () => {
    if (!activeConnection) return;
    setEnabling(true);
    try {
      const updated = await stepUp.run(
        () =>
          storageClient.updateConnection({
            publicId: activeConnection.publicId,
            expectedVersion: activeConnection.version,
            enabled: true,
          }),
        { reason: "Enabling a storage connection requires verification." },
      );
      setSavedConn(updated);
      await queryClient.invalidateQueries({ queryKey: api.connectionsList.queryKey() });
      toast.show({ tone: "success", title: `${updated.name} is now enabled` });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not enable connection",
        description: errorMessage(err),
      });
    } finally {
      setEnabling(false);
    }
  };

  const onWizardNext = () => {
    if (step === "provider") {
      setCompleted((prev) => Array.from(new Set([...prev, "provider"])));
      setStep("credentials");
      return;
    }
    if (step === "credentials") {
      void handleSaveStep2();
      return;
    }
    navigate("/admin/storage");
  };

  const onWizardBack = () => {
    if (step === "verify") {
      setStep("credentials");
      return;
    }
    if (step === "credentials" && !activeConnection) {
      setStep("provider");
    }
  };

  return (
    <>
      <PageHeader
        title={activeConnection ? `Configure ${activeConnection.name}` : "Add storage connection"}
        description="Use your storage provider's own field names. Secrets are encrypted at rest and never echoed back."
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/admin/storage">Back to Storage connections</Link>
          </Button>
        }
      />

      <Card>
        <Wizard
          steps={WIZARD_STEPS}
          current={step}
          completed={completed}
          busy={busy}
          onBack={step === "provider" || (step === "credentials" && Boolean(activeConnection)) ? undefined : onWizardBack}
          onStepSelect={(id) => {
            if (id === "provider" && activeConnection) return;
            setStep(id);
          }}
          nextLabel={
            step === "provider"
              ? "Continue to credentials"
              : step === "credentials"
                ? "Save & continue"
                : "Finish"
          }
          onNext={onWizardNext}
        >
          {step === "provider" ? (
            <RadioGroup
              legend="Storage provider"
              variant="cards"
              value={draft.choiceId}
              onValueChange={(val) => {
                const nextChoice = val as ProviderChoiceId;
                setDraftOverride(createEmptyWizardDraft(nextChoice));
                setErrors({});
              }}
              options={PROVIDER_CHOICES.map((p) => ({
                value: p.id,
                label: p.label,
                description: p.description,
              }))}
            />
          ) : null}

          {step === "credentials" ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">{activeChoice.label}</Badge>
                {activeConnection?.credentialsConfigured ? (
                  <Badge tone="success">Encrypted credentials stored</Badge>
                ) : (
                  <Badge tone="neutral">No credentials stored yet</Badge>
                )}
              </div>

              {errors.rebind ? (
                <Callout tone="danger" title="Disconnect OAuth before changing destination" live="assertive">
                  <p>{errors.rebind}</p>
                </Callout>
              ) : null}

              {activeConnection?.credentialsConfigured ? (
                <Callout tone="info" title="Credential re-binding protection">
                  <p>
                    Leave secret fields blank to keep stored credentials when only renaming the connection. Changing
                    bucket, container, endpoint, site, or client settings requires re-entering the secret so stored
                    keys cannot be redirected to a different destination.
                  </p>
                </Callout>
              ) : null}

              <Field label="Connection display name" required error={errors.name}>
                <Input
                  value={draft.name}
                  maxLength={120}
                  placeholder={`Production ${activeChoice.label}`}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                />
              </Field>

              {/* S3 family: Amazon S3, Wasabi, Backblaze B2, Custom S3 */}
              {activeChoice.kind === "s3" ? (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Bucket name" required error={errors.s3Bucket}>
                      <Input
                        value={draft.s3Bucket}
                        placeholder="readypackets-archive"
                        onChange={(e) => updateDraft({ s3Bucket: e.target.value })}
                      />
                    </Field>
                    <Field label="Region" required error={errors.s3Region}>
                      <Input
                        value={draft.s3Region}
                        placeholder={activeChoice.s3Preset === "backblaze" ? "us-west-004" : "us-east-1"}
                        onChange={(e) => updateDraft({ s3Region: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Object key prefix"
                    hint="Optional folder prefix inside the bucket (for example orders/prod)."
                  >
                    <Input
                      value={draft.s3Prefix}
                      placeholder="orders"
                      onChange={(e) => updateDraft({ s3Prefix: e.target.value })}
                    />
                  </Field>
                  {activeChoice.s3Preset === "custom" ? (
                    <Field
                      label="Endpoint URL"
                      required
                      hint="HTTPS origin on port 443 (path-style addressing). Also add this hostname on the Outbound allowlist page."
                      error={errors.s3Endpoint}
                    >
                      <Input
                        value={draft.s3Endpoint}
                        placeholder="https://s3.storage.example.com"
                        onChange={(e) => updateDraft({ s3Endpoint: e.target.value })}
                      />
                    </Field>
                  ) : null}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field
                      label={activeChoice.s3Preset === "backblaze" ? "Application key ID" : "Access key ID"}
                      required={!activeConnection?.credentialsConfigured}
                      error={errors.s3AccessKeyId}
                    >
                      <Input
                        value={draft.s3AccessKeyId}
                        autoComplete="off"
                        onChange={(e) => updateDraft({ s3AccessKeyId: e.target.value, clearCredentials: false })}
                      />
                    </Field>
                    <Field
                      label={activeChoice.s3Preset === "backblaze" ? "Application key" : "Secret access key"}
                      required={!activeConnection?.credentialsConfigured}
                      error={errors.s3SecretAccessKey}
                    >
                      <Input
                        type="password"
                        value={draft.s3SecretAccessKey}
                        autoComplete="new-password"
                        placeholder={activeConnection?.credentialsConfigured ? "Stored — enter to replace" : ""}
                        onChange={(e) => updateDraft({ s3SecretAccessKey: e.target.value, clearCredentials: false })}
                      />
                    </Field>
                  </div>
                  {activeChoice.s3Preset === "aws" || activeChoice.s3Preset === "custom" ? (
                    <Field label="Session token" hint="Optional temporary STS session token.">
                      <Input
                        type="password"
                        value={draft.s3SessionToken}
                        autoComplete="new-password"
                        onChange={(e) => updateDraft({ s3SessionToken: e.target.value })}
                      />
                    </Field>
                  ) : null}
                </>
              ) : null}

              {/* Azure Blob Storage */}
              {activeChoice.kind === "azure_blob" ? (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Storage account name" required error={errors.azureAccount}>
                      <Input
                        value={draft.azureAccount}
                        placeholder="readypacketsprod"
                        onChange={(e) => updateDraft({ azureAccount: e.target.value })}
                      />
                    </Field>
                    <Field label="Container name" required error={errors.azureContainer}>
                      <Input
                        value={draft.azureContainer}
                        placeholder="order-archives"
                        onChange={(e) => updateDraft({ azureContainer: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Blob prefix" hint="Optional virtual directory prefix.">
                      <Input
                        value={draft.azurePrefix}
                        placeholder="portal"
                        onChange={(e) => updateDraft({ azurePrefix: e.target.value })}
                      />
                    </Field>
                    <Field label="Authentication method">
                      <Select
                        value={draft.azureAuth}
                        onChange={(e) => updateDraft({ azureAuth: e.target.value as "shared_key" | "sas" })}
                        options={[
                          { value: "shared_key", label: "Shared Key (Account key)" },
                          { value: "sas", label: "Container HTTPS SAS token" },
                        ]}
                      />
                    </Field>
                  </div>
                  {draft.azureAuth === "shared_key" ? (
                    <Field
                      label="Account key"
                      required={!activeConnection?.credentialsConfigured}
                      hint="88-character base64 key from Azure Storage account Access keys."
                      error={errors.azureAccountKey}
                    >
                      <Input
                        type="password"
                        value={draft.azureAccountKey}
                        autoComplete="new-password"
                        placeholder={activeConnection?.credentialsConfigured ? "Stored — enter to replace" : ""}
                        onChange={(e) => updateDraft({ azureAccountKey: e.target.value, clearCredentials: false })}
                      />
                    </Field>
                  ) : (
                    <Field
                      label="SAS token"
                      required={!activeConnection?.credentialsConfigured}
                      hint="Container-scoped HTTPS SAS query string (sr=c&spr=https&sv=...&sig=...)."
                      error={errors.azureSasToken}
                    >
                      <Input
                        type="password"
                        value={draft.azureSasToken}
                        autoComplete="new-password"
                        placeholder={activeConnection?.credentialsConfigured ? "Stored — enter to replace" : ""}
                        onChange={(e) => updateDraft({ azureSasToken: e.target.value, clearCredentials: false })}
                      />
                    </Field>
                  )}
                </>
              ) : null}

              {/* Dropbox & Google Drive */}
              {activeChoice.kind === "dropbox" || activeChoice.kind === "google_drive" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Field
                      label="Redirect URI (register this exact URL in your provider app console)"
                      hint="Copy and add this callback URL to your own OAuth app before starting Connect."
                    >
                      <Input readOnly value={redirectUri} className="font-mono text-xs" />
                    </Field>
                    <div>
                      <CopyButton value={redirectUri} label="Copy Redirect URI" />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field
                      label={activeChoice.kind === "dropbox" ? "App key" : "Client ID"}
                      required
                      error={errors.oauthClientId}
                    >
                      <Input
                        value={draft.oauthClientId}
                        autoComplete="off"
                        onChange={(e) => updateDraft({ oauthClientId: e.target.value })}
                      />
                    </Field>
                    <Field
                      label={activeChoice.kind === "dropbox" ? "App secret" : "Client secret"}
                      required={!activeConnection?.credentialsConfigured}
                      error={errors.oauthClientSecret}
                    >
                      <Input
                        type="password"
                        value={draft.oauthClientSecret}
                        autoComplete="new-password"
                        placeholder={activeConnection?.credentialsConfigured ? "Stored — enter to replace" : ""}
                        onChange={(e) => updateDraft({ oauthClientSecret: e.target.value, clearCredentials: false })}
                      />
                    </Field>
                  </div>
                  <Field
                    label={activeChoice.kind === "dropbox" ? "App folder path" : "Folder path"}
                    hint={
                      activeChoice.kind === "google_drive"
                        ? "Managed relative folder path created and owned by ReadyPackets (defaults to ReadyPackets)."
                        : "Optional relative folder path inside Dropbox (for example ReadyPackets/Orders)."
                    }
                  >
                    <Input
                      value={draft.oauthRootPath}
                      placeholder="ReadyPackets"
                      onChange={(e) => updateDraft({ oauthRootPath: e.target.value })}
                    />
                  </Field>
                </>
              ) : null}

              {/* SharePoint library & OneDrive for Business */}
              {activeChoice.kind === "sharepoint" || activeChoice.kind === "onedrive" ? (
                <>
                  <Callout tone="info" title="Least-privilege Microsoft Entra app permissions">
                    <p>
                      Use a single-tenant Microsoft Entra app registration. Prefer <code>Sites.Selected</code> for a
                      specific SharePoint site; scope OneDrive for Business to a dedicated service account UPN.
                    </p>
                  </Callout>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Directory (tenant) ID" required error={errors.graphTenantId}>
                      <Input
                        value={draft.graphTenantId}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        onChange={(e) => updateDraft({ graphTenantId: e.target.value })}
                      />
                    </Field>
                    <Field label="Application (client) ID" required error={errors.graphClientId}>
                      <Input
                        value={draft.graphClientId}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        onChange={(e) => updateDraft({ graphClientId: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Client secret"
                    required={!activeConnection?.credentialsConfigured}
                    error={errors.graphClientSecret}
                  >
                    <Input
                      type="password"
                      value={draft.graphClientSecret}
                      autoComplete="new-password"
                      placeholder={activeConnection?.credentialsConfigured ? "Stored — enter to replace" : ""}
                      onChange={(e) => updateDraft({ graphClientSecret: e.target.value, clearCredentials: false })}
                    />
                  </Field>
                  {activeChoice.kind === "sharepoint" ? (
                    <Field
                      label="SharePoint site URL"
                      required
                      hint="Example: https://contoso.sharepoint.com/sites/Operations"
                      error={errors.sharepointSiteUrl}
                    >
                      <Input
                        type="url"
                        value={draft.sharepointSiteUrl}
                        placeholder="https://contoso.sharepoint.com/sites/Operations"
                        onChange={(e) => updateDraft({ sharepointSiteUrl: e.target.value })}
                      />
                    </Field>
                  ) : (
                    <Field
                      label="Account UPN (e-mail)"
                      required
                      hint="Dedicated Microsoft 365 account whose OneDrive will store copies."
                      error={errors.onedriveUpn}
                    >
                      <Input
                        type="email"
                        value={draft.onedriveUpn}
                        placeholder="archive-bot@contoso.com"
                        onChange={(e) => updateDraft({ onedriveUpn: e.target.value })}
                      />
                    </Field>
                  )}
                </>
              ) : null}

              {activeConnection?.credentialsConfigured ? (
                <Checkbox
                  label="Clear stored credentials"
                  checked={draft.clearCredentials}
                  onCheckedChange={(checked) => updateDraft({ clearCredentials: checked })}
                />
              ) : null}
            </div>
          ) : null}

          {step === "verify" && activeConnection ? (
            <div className="flex flex-col gap-5">
              <KeyValueList
                items={[
                  { label: "Provider", value: activeChoice.label },
                  { label: "Connection", value: activeConnection.name },
                  {
                    label: "Current state",
                    value: (
                      <Badge tone={describeConnectionStatus(activeConnection).tone}>
                        {describeConnectionStatus(activeConnection).label}
                      </Badge>
                    ),
                  },
                ]}
              />

              {/* Step 3A: OAuth Consent for Dropbox / Google Drive */}
              {activeChoice.usesOAuth ? (
                <Card
                  title={`Authorize ${activeChoice.label} via OAuth 2.0`}
                  description="Starts an authorization code + PKCE redirect bound to your administrator session."
                >
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-body">
                      Status:{" "}
                      <strong>
                        {activeConnection.oauthConnected
                          ? "Connected (refresh token stored)"
                          : "Awaiting OAuth consent"}
                      </strong>
                    </p>
                    <div>
                      <Button
                        type="button"
                        variant="secondary"
                        loading={busy}
                        onClick={() => void handleStartOAuthFromWizard()}
                      >
                        {activeConnection.oauthConnected
                          ? `Reconnect ${activeChoice.label}`
                          : `Connect with ${activeChoice.label}`}
                      </Button>
                    </div>
                  </div>
                </Card>
              ) : null}

              {/* Step 3B: Library & Folder Discovery for SharePoint / OneDrive */}
              {activeChoice.usesDiscovery ? (
                <Card
                  title={
                    activeChoice.kind === "sharepoint"
                      ? "Discover SharePoint site & document library"
                      : "Resolve OneDrive for Business library"
                  }
                  description="Ensure Microsoft Graph outbound presets are enabled before running discovery."
                >
                  <div className="flex flex-col gap-4">
                    <div>
                      <Button
                        type="button"
                        variant="secondary"
                        loading={discovering}
                        onClick={() => void handleDiscoverGraph()}
                      >
                        {activeChoice.kind === "sharepoint"
                          ? "Discover site & libraries"
                          : "Resolve OneDrive"}
                      </Button>
                    </div>

                    {discoveredSiteLabel ? (
                      <p className="text-sm text-body">
                        Discovered site: <strong>{discoveredSiteLabel}</strong>
                      </p>
                    ) : null}

                    {drives.length > 0 ? (
                      <Field label="Document library">
                        <Select
                          value={draft.graphDriveId}
                          onChange={(e) => {
                            const driveId = e.target.value;
                            const found = drives.find((d) => d.driveId === driveId);
                            updateDraft({
                              graphDriveId: driveId,
                              graphDriveName: found?.name ?? "",
                            });
                          }}
                          options={drives.map((d) => ({ value: d.driveId, label: d.name }))}
                        />
                      </Field>
                    ) : draft.graphDriveName ? (
                      <p className="text-sm text-body">
                        Selected drive: <strong>{draft.graphDriveName}</strong>
                      </p>
                    ) : null}

                    {folders.length > 0 ? (
                      <Field label="Existing root folder (optional)">
                        <Select
                          value={draft.graphRootFolderPath || "__root__"}
                          onChange={(e) => {
                            const val = e.target.value;
                            updateDraft({ graphRootFolderPath: val === "__root__" ? "" : val });
                          }}
                          options={[
                            { value: "__root__", label: "Library root (/)" },
                            ...folders.map((f) => ({ value: f.path, label: f.path })),
                          ]}
                        />
                      </Field>
                    ) : null}

                    <Field
                      label="Root folder path"
                      hint="Optional subfolder path created automatically inside the selected library."
                    >
                      <Input
                        value={draft.graphRootFolderPath}
                        placeholder="ReadyPackets/Orders"
                        onChange={(e) => updateDraft({ graphRootFolderPath: e.target.value })}
                      />
                    </Field>

                    {!transientGraphSecret ? (
                      <Field
                        label="Confirm Client secret (required to bind library changes)"
                        hint="Re-enter your Entra Client secret when updating library selection from an existing connection."
                      >
                        <Input
                          type="password"
                          value={draft.graphClientSecret}
                          autoComplete="new-password"
                          onChange={(e) => updateDraft({ graphClientSecret: e.target.value })}
                        />
                      </Field>
                    ) : null}

                    <div>
                      <Button
                        type="button"
                        variant="secondary"
                        loading={savingDiscovery}
                        disabled={!draft.graphDriveId}
                        onClick={() => void handleSaveDiscoverySelection()}
                      >
                        Save library selection
                      </Button>
                    </div>
                  </div>
                </Card>
              ) : null}

              {/* Step 3C: Connection Test & Enable */}
              <Card
                title="Test & enable connection"
                description="A connection must pass its non-destructive provider verification check before it can be enabled."
              >
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      loading={testing}
                      onClick={() => void handleRunTest()}
                    >
                      Test connection
                    </Button>
                    {!activeConnection.enabled ? (
                      <Button
                        type="button"
                        loading={enabling}
                        disabled={!describeConnectionStatus(activeConnection).canEnable}
                        onClick={() => void handleEnableNow()}
                      >
                        Enable connection
                      </Button>
                    ) : null}
                  </div>
                  {testOutcome ? (
                    <Callout
                      tone={testOutcome.ok ? "success" : "danger"}
                      title={testOutcome.ok ? "Connection test passed" : "Connection test failed"}
                      live="polite"
                    >
                      <p>{STORAGE_TEST_CODE_LABELS[testOutcome.code]}</p>
                    </Callout>
                  ) : null}
                </div>
              </Card>
            </div>
          ) : null}
        </Wizard>
      </Card>
    </>
  );
}
