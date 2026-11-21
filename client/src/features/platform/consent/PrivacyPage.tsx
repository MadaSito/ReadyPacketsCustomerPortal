/** Account → Privacy and cookies (increment 04, package J). Owner: platform engineer. */
import { useQuery } from "@tanstack/react-query";
import { Cookie, Download } from "lucide-react";
import { consent, useConsent } from "@/lib/consent";
import { useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, DateTime, EmptyState, ErrorState, PageHeader, Skeleton, Timeline } from "@/ui";

const CATEGORY_LABEL = { preferences: "Preferences", analytics: "Analytics", session_replay: "Session replay" } as const;
const ACTION_LABEL = { accept_all: "Accepted all", reject_all: "Rejected all", save: "Saved choices", withdraw: "Withdrew consent" } as const;
const SOURCE_LABEL = { banner: "cookie banner", preferences: "preference centre", account: "account page", gpc: "browser privacy signal" } as const;

interface RecordView {
  publicId: string;
  policyVersion: number;
  choices: { preferences: boolean; analytics: boolean; session_replay: boolean };
  action: keyof typeof ACTION_LABEL;
  source: keyof typeof SOURCE_LABEL;
  gpc: boolean;
  createdAt: Date | string;
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function PrivacyPage() {
  const trpc = useTRPC();
  const state = useConsent();
  const mine = useQuery(trpc.platform.consent.mine.queryOptions());
  const records = (mine.data ?? []) as RecordView[];

  return (
    <>
      <PageHeader title="Privacy and cookies" description="See and change which optional tools may run, and download the record of your choices." />
      <div className="grid gap-6">
        <Card
          title="Your current choices"
          description={state.enabled ? "These apply in this browser." : "This site does not use optional cookies or tools at the moment."}
          actions={state.enabled ? <Button onClick={() => consent.openPreferences()}>Change preferences</Button> : undefined}
        >
          {state.enabled ? (
            <>
              <ul className="grid gap-2 sm:grid-cols-2">
                <li className="flex items-center justify-between gap-3 text-sm">
                  <span>Necessary</span>
                  <Badge tone="neutral">Always on</Badge>
                </li>
                {(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]).map((key) => (
                  <li key={key} className="flex items-center justify-between gap-3 text-sm">
                    <span>{CATEGORY_LABEL[key]}</span>
                    <Badge tone={state.choices[key] ? "success" : "neutral"}>{state.choices[key] ? "Allowed" : "Not allowed"}</Badge>
                  </li>
                ))}
              </ul>
              {state.decidedAt ? (
                <p className="mt-3 text-sm text-body">
                  Chosen <DateTime value={state.decidedAt} format="datetime" />
                  {state.bySignal ? " by your browser's privacy signal" : ""}.
                </p>
              ) : (
                <p className="mt-3 text-sm text-body">You have not made a choice yet, so nothing optional runs.</p>
              )}
              {state.gpc ? (
                <Callout tone="info" className="mt-3">
                  Your browser sends a privacy signal (Global Privacy Control or Do Not Track), so optional tools are off unless you allow them here.
                </Callout>
              ) : null}
            </>
          ) : null}
        </Card>

        <Card
          title="History of your choices"
          description="Choices you made while signed in. Choices made before signing in are kept without your name."
          actions={
            records.length > 0 ? (
              <Button variant="secondary" leadingIcon={<Download className="size-4" aria-hidden />} onClick={() => download("cookie-choices.json", JSON.stringify(records, null, 2), "application/json")}>
                Download
              </Button>
            ) : undefined
          }
        >
          {mine.isPending ? (
            <div aria-busy="true">
              <Skeleton lines={3} />
            </div>
          ) : mine.error ? (
            <ErrorState error={mine.error} onRetry={() => void mine.refetch()} />
          ) : records.length === 0 ? (
            <EmptyState icon={Cookie} title="No choices recorded yet" description="When you choose in the cookie banner or preferences, it appears here." />
          ) : (
            <Timeline
              label="Cookie choices"
              order="newest-first"
              items={records.map((r) => ({
                key: r.publicId,
                title: ACTION_LABEL[r.action],
                time: r.createdAt,
                description: `${(Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[])
                  .map((k) => `${CATEGORY_LABEL[k]}: ${r.choices[k] ? "allowed" : "not allowed"}`)
                  .join(", ")}. Policy version ${r.policyVersion}, from the ${SOURCE_LABEL[r.source]}.`,
              }))}
            />
          )}
        </Card>
      </div>
    </>
  );
}
