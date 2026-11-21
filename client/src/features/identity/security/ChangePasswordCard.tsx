/** Security page card (order 10): change the sign-in password. Changing it signs out every other session. */
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useRefreshSession } from "@/lib/session";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, Field, Input, useToast } from "@/ui";
import { PASSWORD_POLICY, countCodePoints } from "@shared/domain";

export default function ChangePasswordCard() {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefreshSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});
  const change = useMutation(trpc.identity.changePassword.mutationOptions());
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const length = countCodePoints(next.normalize("NFC"));
    const found: typeof errors = {};
    if (!current) found.current = "Enter your current password.";
    if (length < PASSWORD_POLICY.minLength) found.next = `Use at least ${PASSWORD_POLICY.minLength} characters.`;
    else if (length > PASSWORD_POLICY.maxLength) found.next = `Use at most ${PASSWORD_POLICY.maxLength} characters.`;
    if (confirm !== next) found.confirm = "The passwords do not match.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      setCurrent(""); setNext(""); setConfirm("");
      await refresh();
      toast.show({ tone: "success", title: "Password changed", description: "Your other sessions were signed out." });
    } catch (err) {
      const safe = safeError(err);
      if (safe?.reasonCode === "CURRENT_PASSWORD_INCORRECT") setErrors({ current: safe.safeMessage });
      else if (safe?.reasonCode?.startsWith("PASSWORD_")) setErrors({ next: safe.safeMessage });
      else setErrors({ form: errorMessage(err) });
    }
  };
  return (
    <Card as="section" aria-label="Password" title="Password" description={`Use a passphrase of ${PASSWORD_POLICY.minLength} or more characters. Changing it signs out your other sessions.`}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {errors.form ? <Callout tone="danger" live="assertive">{errors.form}</Callout> : null}
        <Field label="Current password" required error={errors.current}>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password" required error={errors.next} hint={`${PASSWORD_POLICY.minLength}–${PASSWORD_POLICY.maxLength} characters. Spaces and any characters are allowed.`}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password" required error={errors.confirm}>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        <div className="flex justify-end"><Button type="submit" loading={change.isPending}>Change password</Button></div>
      </form>
    </Card>
  );
}
