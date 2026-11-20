import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";

export const publicId = z.string().regex(ULID_PATTERN);
export const totpCode = z.string().regex(/^[0-9]{6}$/);
export const totpFactor = z.strictObject({ method: z.literal("totp"), code: totpCode });
const recoveryFactor = z.strictObject({ method: z.literal("recovery_code"), code: z.string().min(32).max(40) });
const b64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);
const envelope = {
  id: b64(1400), rawId: b64(1400), type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  // The RP requests no extensions and makes no authorization decisions from extension output.
  clientExtensionResults: z.strictObject({}),
};
export const registrationResponse = z.strictObject({
  ...envelope,
  response: z.strictObject({
    clientDataJSON: b64(8192),
    attestationObject: b64(32_768),
    authenticatorData: b64(8192).optional(),
    publicKey: b64(8192).optional(),
    publicKeyAlgorithm: z.number().int().min(-65_536).max(65_536).optional(),
    transports: z.array(z.enum(["usb", "nfc", "ble", "internal", "hybrid", "smart-card", "cable"])).max(8).optional(),
  }),
});
export const authenticationResponse = z.strictObject({
  ...envelope,
  response: z.strictObject({
    clientDataJSON: b64(8192),
    authenticatorData: b64(8192),
    signature: b64(8192),
    userHandle: b64(128).optional(),
  }),
});
const passkeyFactor = z.strictObject({ method: z.literal("passkey"), challengeId: publicId, response: authenticationResponse });
export const factorInput = z.discriminatedUnion("method", [
  totpFactor,
  recoveryFactor,
  passkeyFactor,
]);
export const reissueFactor = z.discriminatedUnion("method", [totpFactor, passkeyFactor]);
export type SecondFactorInput = z.infer<typeof factorInput>;
export const passkeyName = z.string().max(160).transform((value) => value.normalize("NFC").trim())
  .pipe(z.string().min(1).max(80).refine((value) => !/[\p{Cc}\p{Bidi_Control}]/u.test(value), "Use a name without control characters."));
export const passwordInput = z.string().min(1).max(512);
export const adminCredentialInput = z.discriminatedUnion("mode", [
  z.strictObject({ customerId: publicId, mode: z.literal("email_link") }),
  z.strictObject({ customerId: publicId, mode: z.literal("generate_temporary") }),
  z.strictObject({ customerId: publicId, mode: z.literal("enter_temporary"), password: passwordInput }),
]);
export type AdminCredentialInput = z.infer<typeof adminCredentialInput>;
