/**
 * Password policy (architecture §4.2, master prompt §5): 15–128 Unicode code points after NFC, no composition
 * rules, no truncation, paste allowed, blocklist + context words. Pure function — unit tested.
 */
import { PASSWORD_POLICY } from "../../../../shared/domain.js";
import { COMMON_BASE_WORDS, COMMON_PASSWORDS, SEQUENCES } from "./blocklist.js";

export type PasswordRejection =
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "PASSWORD_COMMON"
  | "PASSWORD_CONTEXT"
  | "PASSWORD_TOO_SIMPLE";

export const PASSWORD_MESSAGES: Record<PasswordRejection, string> = {
  PASSWORD_TOO_SHORT: `Use at least ${PASSWORD_POLICY.minLength} characters.`,
  PASSWORD_TOO_LONG: `Use at most ${PASSWORD_POLICY.maxLength} characters.`,
  PASSWORD_COMMON: "This password is too common. Choose a less predictable passphrase.",
  PASSWORD_CONTEXT: "Avoid using your name, e-mail address or the service name in your password.",
  PASSWORD_TOO_SIMPLE: "This password is too predictable. Try a longer passphrase of unrelated words.",
};

export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

const BRAND_WORDS = ["readypackets", "ready packets", "readypacket", "rpackets"];
const COMMON_SET = new Set(COMMON_PASSWORDS.map((value) => squash(value)));

function squash(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/gu, "");
}

function contextWords(context: PasswordContext): string[] {
  const words = new Set<string>(BRAND_WORDS.map(squash));
  const local = context.email?.split("@")[0];
  if (local) {
    words.add(squash(local));
    for (const part of local.split(/[._+-]+/)) if ([...part].length >= 3) words.add(squash(part));
  }
  if (context.name) {
    for (const part of context.name.split(/\s+/u)) if ([...part].length >= 3) words.add(squash(part));
  }
  return [...words].filter((word) => [...word].length >= 3).sort((a, b) => b.length - a.length);
}

function isSequenceOnly(value: string): boolean {
  if (value.length < 4) return false;
  for (const seq of SEQUENCES) {
    const forward = seq.repeat(3);
    const backward = [...seq].reverse().join("").repeat(3);
    if (forward.includes(value) || backward.includes(value)) return true;
  }
  return false;
}

/** Characters left after removing low-entropy words, repeats and simple sequences. */
function remainingStrength(squashed: string, extraWords: string[]): number {
  let rest = squashed;
  for (const word of [...extraWords, ...COMMON_BASE_WORDS].sort((a, b) => b.length - a.length)) {
    if (word.length >= 3) rest = rest.split(word).join(" ");
  }
  // Collapse runs of the same character and short sequential runs.
  const pieces = rest.split(" ").filter(Boolean);
  let score = 0;
  for (const piece of pieces) {
    const collapsed = piece.replace(/(.)\1+/gu, "$1");
    if (isSequenceOnly(collapsed)) score += 1;
    else score += [...collapsed].length;
  }
  return score;
}

/** Returns null when acceptable, otherwise the first rejection reason. Never truncates or mutates. */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordRejection | null {
  const normalized = password.normalize("NFC");
  const length = [...normalized].length;
  if (length < PASSWORD_POLICY.minLength) return "PASSWORD_TOO_SHORT";
  if (length > PASSWORD_POLICY.maxLength) return "PASSWORD_TOO_LONG";
  const squashed = squash(normalized);
  if (COMMON_SET.has(squashed)) return "PASSWORD_COMMON";
  if (new Set(squashed).size < 5 || isSequenceOnly(squashed)) return "PASSWORD_TOO_SIMPLE";
  const words = contextWords(context);
  const withoutContext = remainingStrength(squashed, words);
  const withoutCommon = remainingStrength(squashed, []);
  if (withoutCommon < 8) return "PASSWORD_COMMON";
  if (withoutContext < 8) return "PASSWORD_CONTEXT";
  return null;
}
