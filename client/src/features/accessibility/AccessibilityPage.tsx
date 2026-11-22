import { BRAND } from "@shared/brand";
import { ThemeToggle } from "@/app/shell/common";
import { useSession } from "@/lib/session";
import { Card, PageHeader, Section } from "@/ui";

const EMAIL = "info@readypackets.com";
const linkClass = "inline-flex min-h-6 max-w-full items-center text-action underline underline-offset-2 [overflow-wrap:anywhere]";

export default function AccessibilityPage() {
  const { view } = useSession();
  return (
    <article className="mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
      <PageHeader
        title="Accessibility"
        description="Our accessibility target for the ReadyPackets customer portal and how to get help if something gets in your way."
        actions={view.status === "anonymous" ? <ThemeToggle /> : undefined}
      />
      <Card as="section" aria-labelledby="accessibility-report" className="space-y-3">
        <h2 id="accessibility-report" className="text-lg font-semibold text-ink">Report an accessibility barrier</h2>
        <p className="text-body">
          Email <a className={linkClass} href={`mailto:${EMAIL}`}>{EMAIL}</a> or use the{" "}
          <a className={linkClass} href={`${BRAND.marketingUrl}/contact.html`}>ReadyPackets contact page</a>. You do not need to sign in to report a barrier.
        </p>
        <p className="mt-3 text-body">
          If you can, tell us which page you were on, what you were trying to do, and what got in the way. You can also ask for help completing the task in another way. Please leave out passwords, verification codes, and private order information.
        </p>
      </Card>
      <Section id="accessibility-standard" title="What we aim for">
        <p className="text-body">The ReadyPackets customer portal is designed and tested against WCAG 2.2 AA (Web Content Accessibility Guidelines). That is our target, not a claim that every page or workflow meets every requirement.</p>
      </Section>
      <Section id="accessibility-limitations" title="Known limits of our testing">
        <p className="text-body">Automated checks cannot verify the whole experience. Not all signed-in workflows, screen reader and browser combinations, or documents and audio supplied by users have been manually checked. If you encounter a problem, please tell us so we can investigate and help.</p>
      </Section>
    </article>
  );
}
