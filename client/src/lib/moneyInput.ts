function fractionDigits(currency?: string): number {
  if (currency === undefined) return 2;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Parse a decimal money input into an exact, safe integer without rounding fractional digits. */
export function parseDecimalToMinor(raw: string, allowZero = true, currency?: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(trimmed);
  const whole = match?.[1];
  const fraction = match?.[2] ?? "";
  const digits = fractionDigits(currency);
  if (whole === undefined || fraction.length > digits) return null;
  const total = Number(whole + fraction.padEnd(digits, "0"));
  if (!Number.isSafeInteger(total) || (!allowZero && total === 0)) return null;
  return total;
}

export function formatMinorToDecimalInput(minor: number, currency?: string): string {
  const digits = fractionDigits(currency);
  const safe = String(Math.max(0, Math.trunc(minor)));
  if (digits === 0) return safe;
  const padded = safe.padStart(digits + 1, "0");
  return `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}
