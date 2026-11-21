/** /sso/refused?reason=SSO_* — a refused single sign-on attempt, explained in plain language. */
import { Link, useSearch } from "wouter";
import { Button, Callout, PageHeader } from "@/ui";
import { ssoRefusal } from "./messages";

export default function SsoRefusedPage() {
  const reason = new URLSearchParams(useSearch()).get("reason");
  const message = ssoRefusal(reason && /^SSO_[A-Z_]{2,40}$/.test(reason) ? reason : null);
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-10">
      <PageHeader title={message.title} />
      <Callout tone="warning">{message.body}</Callout>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button asChild><Link href="/sign-in">Back to sign-in</Link></Button>
        <Button asChild variant="secondary"><Link href="/">Home</Link></Button>
      </div>
    </div>
  );
}
