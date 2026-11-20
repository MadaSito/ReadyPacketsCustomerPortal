/**
 * One-time display of recovery codes: copy, download as a client-generated text file, explicit
 * acknowledgment. Codes live only in component memory / the in-memory batch hand-off.
 */
import { Download } from "lucide-react";
import { useState } from "react";
import type { RecoveryBatch } from "@/lib/recoveryBatch";
import { errorMessage } from "@/lib/trpc";
import { Button, Callout, Checkbox, CopyButton } from "@/ui";
import { FormError, useFocusOnError } from "./bits";

export function recoveryCodesText(codes: readonly string[], generatedAt = new Date()): string {
  return [
    "ReadyPackets recovery codes",
    `Generated: ${generatedAt.toISOString()}`,
    "Each code can be used once to sign in if you lose access to your authenticator or passkey.",
    "Store them somewhere safe, such as your password manager.",
    "",
    ...codes,
    "",
  ].join("\n");
}

function download(codes: readonly string[]) {
  const blob = new Blob([recoveryCodesText(codes)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "readypackets-recovery-codes.txt";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RecoveryCodesPanel({ batch, onAcknowledge }: { batch: RecoveryBatch; onAcknowledge: (recoverySetId: string) => Promise<void> }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useFocusOnError(error);

  const confirm = async () => {
    if (!saved) {
      setError("Confirm that you have saved your recovery codes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAcknowledge(batch.recoverySetId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Callout tone="warning" title="Save these codes now">
        They are shown only once. Each code signs you in a single time if you lose your authenticator app or passkey.
      </Callout>
      <ol aria-label="Recovery codes" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-2 rounded-[var(--radius-card)] border border-line bg-surface-sunken p-3 font-mono text-sm text-ink sm:p-4">
        {batch.recoveryCodes.map((code) => (
          <li key={code} className="rounded-md bg-surface px-3 py-2 text-center tracking-wide [overflow-wrap:anywhere]">
            {code}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={batch.recoveryCodes.join("\n")} label="Copy all codes" size="md" />
        <Button variant="secondary" leadingIcon={<Download aria-hidden="true" />} onClick={() => download(batch.recoveryCodes)}>
          Download as text
        </Button>
      </div>
      <FormError message={error} focusRef={errorRef} />
      <Checkbox label="I have saved my recovery codes in a safe place" checked={saved} onCheckedChange={setSaved} required />
      <Button size="lg" block onClick={confirm} loading={busy} disabled={!saved}>
        Continue
      </Button>
    </div>
  );
}
