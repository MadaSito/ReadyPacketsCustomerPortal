import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import { DomainError, validation } from "../../core/errors.js";
import type { FieldCrypto, SettingsStore, Tx } from "../../core/types.js";
import { defineSecret, defineSetting } from "../platform/settingsRegistry.js";
import type { SiemSecretInput } from "./types.js";

export const SIEM_BATCH_SIZE = defineSetting({
  key: "siem.delivery.batch_size",
  owner: "siem",
  group: "observability",
  label: "SIEM delivery batch size",
  description: "Maximum projected audit events transmitted per outbound batch.",
  schema: z.number().int().min(1).max(500),
  default: 100,
  sensitivity: "internal",
});

export const SIEM_MAX_ATTEMPTS = defineSetting({
  key: "siem.delivery.max_attempts",
  owner: "siem",
  group: "observability",
  label: "SIEM maximum delivery attempts",
  description: "Maximum delivery attempts before a batch item moves to the dead-letter queue.",
  schema: z.number().int().min(1).max(20),
  default: 8,
  sensitivity: "internal",
});

export const SIEM_SPOOL_MAX_EVENTS = defineSetting({
  key: "siem.delivery.spool_max_events",
  owner: "siem",
  group: "observability",
  label: "SIEM per-destination spool limit",
  description: "Maximum queued plus dead-lettered events held per destination before cursor backpressure engages.",
  schema: z.number().int().min(100).max(100_000),
  default: 10_000,
  sensitivity: "internal",
});

export const SIEM_OLDEST_ALERT_SECONDS = defineSetting({
  key: "siem.delivery.oldest_alert_seconds",
  owner: "siem",
  group: "observability",
  label: "SIEM oldest pending alert threshold (seconds)",
  description: "Pending spool age in seconds that degrades SIEM delivery health.",
  schema: z.number().int().min(30).max(86_400),
  default: 300,
  sensitivity: "internal",
});

export const SIEM_CIRCUIT_THRESHOLD = defineSetting({
  key: "siem.delivery.circuit_threshold",
  owner: "siem",
  group: "observability",
  label: "SIEM circuit-breaker failure threshold",
  description: "Consecutive transport failures before opening the per-destination circuit breaker.",
  schema: z.number().int().min(1).max(50),
  default: 5,
  sensitivity: "internal",
});

export const SIEM_CIRCUIT_COOLDOWN_SECONDS = defineSetting({
  key: "siem.delivery.circuit_cooldown_seconds",
  owner: "siem",
  group: "observability",
  label: "SIEM circuit-breaker cooldown (seconds)",
  description: "Cooldown duration before an open circuit probes recovery in half-open state.",
  schema: z.number().int().min(10).max(3_600),
  default: 60,
  sensitivity: "internal",
});

export const SIEM_DEFAULT_CA_BUNDLE = defineSecret({
  key: "siem.tls.default_ca_bundle",
  owner: "siem",
  group: "observability",
  label: "Default SIEM custom CA bundle",
  description: "Optional installation-wide PEM CA bundle used when a destination does not specify its own CA.",
  schema: z.string().min(32).max(65_536),
  exportable: false,
});

export const SIEM_DEFAULT_CLIENT_CERT = defineSecret({
  key: "siem.tls.default_client_cert",
  owner: "siem",
  group: "observability",
  label: "Default SIEM mTLS client certificate",
  description: "Optional installation-wide PEM client certificate for mutual TLS.",
  schema: z.string().min(32).max(65_536),
  exportable: false,
});

export const SIEM_DEFAULT_CLIENT_KEY = defineSecret({
  key: "siem.tls.default_client_key",
  owner: "siem",
  group: "observability",
  label: "Default SIEM mTLS client private key",
  description: "Optional installation-wide PEM client private key for mutual TLS.",
  schema: z.string().min(32).max(65_536),
  exportable: false,
});

export const SIEM_DESTINATION_CREDENTIALS = defineSecret({
  key: "siem.destinations.credentials",
  owner: "siem",
  group: "observability",
  label: "SIEM per-destination encrypted credentials",
  description: "Write-only encrypted credential ring for SIEM destination CA bundles, mTLS keys, and OTLP tokens.",
  schema: z.string().min(2).max(524_288),
  exportable: false,
});

export interface StoredDestinationSecretEntry {
  caEnc?: string;
  certEnc?: string;
  keyEnc?: string;
  authEnc?: string;
}

type SecretRingMap = Record<string, StoredDestinationSecretEntry>;

const secretEntrySchema = z.object({
  caEnc: z.string().min(1).max(131_072).optional(),
  certEnc: z.string().min(1).max(131_072).optional(),
  keyEnc: z.string().min(1).max(131_072).optional(),
  authEnc: z.string().min(1).max(16_384).optional(),
});

const secretRingSchema = z.record(z.string().min(1).max(64), secretEntrySchema);

export interface ResolvedDestinationSecrets {
  customCaPem: string | null;
  clientCertPem: string | null;
  clientKeyPem: string | null;
  authSecret: string | null;
}

export interface ValidatedTlsMaterial {
  customCaPem: string | null;
  clientCertPem: string | null;
  clientKeyPem: string | null;
  authSecret: string | null;
  caCertExpiresAt: Date | null;
  clientCertExpiresAt: Date | null;
}

const PEM_CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export function parseCaBundleAndExpiry(pemBundle: string): Date {
  const normalized = pemBundle.replace(/\r\n/g, "\n").trim();
  if (normalized.length > 65_536) {
    throw validation("INVALID_TLS_CA", "The custom CA bundle exceeds the maximum allowed size.");
  }
  const matches = normalized.match(PEM_CERT_BLOCK);
  if (!matches || matches.length === 0 || matches.length > 16) {
    throw validation("INVALID_TLS_CA", "Provide between 1 and 16 PEM-encoded X.509 CA certificates.");
  }
  let earliestExpiry: Date | null = null;
  for (const block of matches) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      throw validation("INVALID_TLS_CA", "One or more certificates in the CA bundle could not be parsed.");
    }
    const validTo = new Date(cert.validTo);
    if (Number.isNaN(validTo.getTime())) {
      throw validation("INVALID_TLS_CA", "A certificate in the CA bundle has an invalid expiration date.");
    }
    if (!earliestExpiry || validTo.getTime() < earliestExpiry.getTime()) {
      earliestExpiry = validTo;
    }
  }
  return earliestExpiry!;
}

export function validateClientCertAndKeyPair(certPem: string, keyPem: string): Date {
  const cleanCert = certPem.replace(/\r\n/g, "\n").trim();
  const cleanKey = keyPem.replace(/\r\n/g, "\n").trim();
  if (cleanCert.length > 32_768 || cleanKey.length > 32_768) {
    throw validation("INVALID_MTLS_MATERIAL", "The client certificate or private key exceeds the maximum size.");
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(cleanCert);
  } catch {
    throw validation("INVALID_MTLS_CERT", "The mTLS client certificate is not a valid PEM X.509 certificate.");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: cleanKey, format: "pem" });
  } catch {
    throw validation(
      "INVALID_MTLS_KEY",
      "The mTLS client private key is not a valid unencrypted PEM private key.",
    );
  }
  try {
    const certSpki = cert.publicKey.export({ type: "spki", format: "der" });
    const keySpki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    if (!certSpki.equals(keySpki)) {
      throw validation(
        "MTLS_KEY_MISMATCH",
        "The mTLS client private key does not match the provided client certificate.",
      );
    }
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw validation("INVALID_MTLS_MATERIAL", "The mTLS client certificate and private key could not be verified.");
  }
  const expiresAt = new Date(cert.validTo);
  if (Number.isNaN(expiresAt.getTime())) {
    throw validation("INVALID_MTLS_CERT", "The mTLS client certificate has an invalid expiration date.");
  }
  return expiresAt;
}

export function validateAuthSecretValue(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length === 0 || trimmed.length > 4096 || /[\r\n\0]/.test(trimmed)) {
    throw validation("INVALID_AUTH_SECRET", "The collector authentication secret is not valid.");
  }
  return trimmed;
}

async function loadSecretRing(settings: SettingsStore, tx?: Tx): Promise<SecretRingMap> {
  const raw = await settings.getSecret(SIEM_DESTINATION_CREDENTIALS.key, tx);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError("UNAVAILABLE", "SECRET_UNREADABLE", "Stored SIEM credentials could not be read safely.");
  }
  const checked = secretRingSchema.safeParse(parsed);
  if (!checked.success) {
    throw new DomainError("UNAVAILABLE", "SECRET_UNREADABLE", "Stored SIEM credentials could not be read safely.");
  }
  return { ...checked.data };
}

function aadFor(publicId: string, slot: "ca" | "cert" | "key" | "auth"): string {
  return `siem_destinations.${slot}:${publicId}`;
}

export async function readDestinationSecrets(
  settings: SettingsStore,
  crypto: FieldCrypto,
  publicId: string,
  tx?: Tx,
): Promise<ResolvedDestinationSecrets> {
  const ring = await loadSecretRing(settings, tx);
  const entry = ring[publicId];
  const decryptSlot = (ciphertext: string | undefined, slot: "ca" | "cert" | "key" | "auth"): string | null => {
    if (!ciphertext) return null;
    try {
      return crypto.decrypt(ciphertext, aadFor(publicId, slot));
    } catch {
      throw new DomainError("UNAVAILABLE", "SECRET_UNREADABLE", "Stored SIEM credentials could not be decrypted.");
    }
  };

  let customCaPem = decryptSlot(entry?.caEnc, "ca");
  let clientCertPem = decryptSlot(entry?.certEnc, "cert");
  let clientKeyPem = decryptSlot(entry?.keyEnc, "key");
  const authSecret = decryptSlot(entry?.authEnc, "auth");

  // Fall back to optional installation-wide defaults in SettingsStore when per-destination TLS secrets are unset.
  if (!customCaPem) {
    customCaPem = await settings.getSecret(SIEM_DEFAULT_CA_BUNDLE.key, tx);
  }
  if (!clientCertPem && !clientKeyPem) {
    const [defaultCert, defaultKey] = await Promise.all([
      settings.getSecret(SIEM_DEFAULT_CLIENT_CERT.key, tx),
      settings.getSecret(SIEM_DEFAULT_CLIENT_KEY.key, tx),
    ]);
    if (defaultCert && defaultKey) {
      clientCertPem = defaultCert;
      clientKeyPem = defaultKey;
    }
  }

  return { customCaPem, clientCertPem, clientKeyPem, authSecret };
}

export interface PreparedDestinationSecrets {
  material: ValidatedTlsMaterial;
  persist: () => Promise<void>;
}

export async function prepareDestinationSecrets(
  settings: SettingsStore,
  crypto: FieldCrypto,
  publicId: string,
  patch: SiemSecretInput | undefined,
  tx?: Tx,
): Promise<PreparedDestinationSecrets> {
  const ring = await loadSecretRing(settings, tx);
  const current = ring[publicId] ?? {};

  const decryptExisting = (ciphertext: string | undefined, slot: "ca" | "cert" | "key" | "auth"): string | null => {
    if (!ciphertext) return null;
    try {
      return crypto.decrypt(ciphertext, aadFor(publicId, slot));
    } catch {
      throw new DomainError("UNAVAILABLE", "SECRET_UNREADABLE", "Existing SIEM credentials could not be decrypted.");
    }
  };

  const nextCa =
    patch?.customCaPem === undefined
      ? decryptExisting(current.caEnc, "ca")
      : patch.customCaPem === null || patch.customCaPem.trim() === ""
        ? null
        : patch.customCaPem.replace(/\r\n/g, "\n").trim();

  const nextCert =
    patch?.clientCertPem === undefined
      ? decryptExisting(current.certEnc, "cert")
      : patch.clientCertPem === null || patch.clientCertPem.trim() === ""
        ? null
        : patch.clientCertPem.replace(/\r\n/g, "\n").trim();

  const nextKey =
    patch?.clientKeyPem === undefined
      ? decryptExisting(current.keyEnc, "key")
      : patch.clientKeyPem === null || patch.clientKeyPem.trim() === ""
        ? null
        : patch.clientKeyPem.replace(/\r\n/g, "\n").trim();

  const nextAuth =
    patch?.authSecret === undefined
      ? decryptExisting(current.authEnc, "auth")
      : patch.authSecret === null || patch.authSecret.trim() === ""
        ? null
        : validateAuthSecretValue(patch.authSecret);

  if ((nextCert !== null) !== (nextKey !== null)) {
    throw validation(
      "MTLS_INCOMPLETE",
      "Mutual TLS requires both a client certificate and its matching private key.",
    );
  }

  const caCertExpiresAt = nextCa ? parseCaBundleAndExpiry(nextCa) : null;
  const clientCertExpiresAt = nextCert && nextKey ? validateClientCertAndKeyPair(nextCert, nextKey) : null;

  let serializedToPersist: string | null | undefined;
  if (patch !== undefined) {
    const nextEntry: StoredDestinationSecretEntry = {};
    if (nextCa) nextEntry.caEnc = crypto.encrypt(nextCa, aadFor(publicId, "ca"));
    if (nextCert) nextEntry.certEnc = crypto.encrypt(nextCert, aadFor(publicId, "cert"));
    if (nextKey) nextEntry.keyEnc = crypto.encrypt(nextKey, aadFor(publicId, "key"));
    if (nextAuth) nextEntry.authEnc = crypto.encrypt(nextAuth, aadFor(publicId, "auth"));

    if (Object.keys(nextEntry).length === 0) {
      delete ring[publicId];
    } else {
      ring[publicId] = nextEntry;
    }

    serializedToPersist = Object.keys(ring).length === 0 ? null : JSON.stringify(ring);
  }

  return {
    material: {
      customCaPem: nextCa,
      clientCertPem: nextCert,
      clientKeyPem: nextKey,
      authSecret: nextAuth,
      caCertExpiresAt,
      clientCertExpiresAt,
    },
    persist: async () => {
      if (serializedToPersist !== undefined) {
        await settings.setSecret(SIEM_DESTINATION_CREDENTIALS.key, serializedToPersist, tx);
      }
    },
  };
}

export async function deleteDestinationSecrets(settings: SettingsStore, publicId: string, tx?: Tx): Promise<void> {
  const raw = await settings.getSecret(SIEM_DESTINATION_CREDENTIALS.key, tx);
  if (raw === null) return;
  let ring: SecretRingMap;
  try {
    ring = secretRingSchema.parse(JSON.parse(raw));
  } catch {
    // Deleting a destination cleans up corrupt/retired secret entries rather than stranding deletion.
    await settings.setSecret(SIEM_DESTINATION_CREDENTIALS.key, null, tx);
    return;
  }
  if (!(publicId in ring)) return;
  delete ring[publicId];
  const serialized = Object.keys(ring).length === 0 ? null : JSON.stringify(ring);
  await settings.setSecret(SIEM_DESTINATION_CREDENTIALS.key, serialized, tx);
}
