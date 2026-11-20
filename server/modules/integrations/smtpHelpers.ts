/**
 * Pure SMTP validation helpers shared by `smtp.ts` and tests.
 */
import { validation } from "../../core/errors.js";
import {
  hasNoHeaderInjection,
  INTEGRATIONS_SMTP_CONFIG,
  INTEGRATIONS_SMTP_FLAG,
  INTEGRATIONS_SMTP_PASSWORD,
  safeEmailAddressSchema,
  type SmtpConfigSetting,
} from "./settings.js";

export {
  hasNoHeaderInjection,
  INTEGRATIONS_SMTP_CONFIG,
  INTEGRATIONS_SMTP_FLAG,
  INTEGRATIONS_SMTP_PASSWORD,
  safeEmailAddressSchema,
  type SmtpConfigSetting,
};

export function precheckSmtpPortAndTls(port: number, tlsMode: string): void {
  if (tlsMode !== "starttls" && tlsMode !== "implicit") {
    throw validation(
      "SMTP_PLAINTEXT_FORBIDDEN",
      "Plaintext SMTP is forbidden; select STARTTLS or Implicit TLS.",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw validation("INVALID_SMTP_PORT", "SMTP port must be between 1 and 65535.");
  }
  if (port === 25) {
    throw validation(
      "SMTP_PORT_25_FORBIDDEN",
      "Unencrypted relay port 25 is refused; configure authenticated STARTTLS (587) or implicit TLS (465).",
    );
  }
}
