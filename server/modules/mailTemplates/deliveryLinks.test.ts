import { describe, expect, it } from "vitest";
import { createTestDeps } from "../../../tests/helpers/fakes.js";
import { registerComplianceMailTemplates } from "../compliance/mail.js";
import { registerEngagementMailTemplates } from "../engagement/mail.js";
import { IDENTITY_MAIL_TEMPLATES } from "../identity/mail.js";
import { createMailer, mailEngineFor } from "../jobs/mail.js";
import { registerRefundNotice } from "../jobs/refundSupport.js";
import { registerOrderMailTemplates } from "../orders/mail.js";
import { registerReferralsMailTemplates } from "../referrals/mail.js";
import { ensureGenericAutomationTemplateRegistered } from "./automationAction.js";
import {
  escapeHtmlText, isMailUrlVariable, plainTextToDeliveryHtml, renderMailTemplateVersion,
} from "./sanitizer.js";
import { buildSystemTemplateMetadata, registerAdditionalShippedMailTemplates, renderShippedMail } from "./systemCatalogue.js";

const h = createTestDeps();
const origin = h.config.canonicalOrigin;
const mailer = createMailer(h.deps);
const registry = mailEngineFor(mailer)!;
for (const template of IDENTITY_MAIL_TEMPLATES) mailer.registerTemplate(template);
registerOrderMailTemplates(mailer);
registerComplianceMailTemplates(mailer);
registerEngagementMailTemplates(mailer);
registerReferralsMailTemplates(mailer);
registerRefundNotice(mailer);
ensureGenericAutomationTemplateRegistered(mailer);
registerAdditionalShippedMailTemplates(mailer, new Set(registry.getBuiltinMailTemplates().map(({ key }) => key)));

describe("HTML and text alternatives for registered mail", () => {
  it.each(registry.getBuiltinMailTemplates().map((template) => [template.key, template] as const))("%s", (_key, template) => {
    const metadata = buildSystemTemplateMetadata(template);
    const destinations = new Map<string, string>();
    const vars = Object.fromEntries(metadata.declaredVars.map(({ name, sampleValue }) => {
      if (isMailUrlVariable(name)) {
        const path = `/test-mail/${name}?first=alpha&second=beta`;
        destinations.set(name, `${origin}${path}`);
        return [name, name === "portalPath" ? path : `${origin}${path}`];
      }
      if (template.key === "automations.generic_notice" && name === "body") {
        const url = `${origin}/orders/demo`;
        destinations.set(name, url);
        return [name, `Your order is ready: ${url}`];
      }
      return [name, sampleValue];
    }));
    const { text, html } = renderShippedMail(template, metadata, vars, origin);
    expect(html).toContain("<html");
    for (const [name, url] of destinations) {
      const href = `href="${escapeHtmlText(url)}"`;
      expect(html).toContain(href);
      expect(text.split("\n")).toContain(url);
      if (isMailUrlVariable(name)) {
        const anchor = html.split("<a ").find((part) => part.startsWith(href));
        expect(anchor?.slice(href.length)).toMatch(/^[^>]*>[^<]+<\/a>/u);
      }
    }
  });
});

describe("post-substitution mail links", () => {
  it("links only decoded text, preserves authored anchors and balances trailing punctuation", () => {
    const rendered = renderMailTemplateVersion({
      format: "html",
      subjectTemplate: "See your order",
      bodyHtmlTemplate: '<p>See ({{portalPath}}). <strong>https://example.test/wiki/Page_(one)</strong> <a href="https://example.test/old">https://example.test/label</a> <a href="mailto:help@example.test">Contact us</a> &lt;img&gt;</p>',
      bodyTextTemplate: "View {{portalPath}}",
      declaredVars: ["portalPath"],
      vars: { portalPath: "/orders/demo?a=1&b=2" },
      canonicalOrigin: origin,
    });
    const href = `${origin}/orders/demo?a=1&amp;b=2`;
    expect(rendered.html).toContain(`(<a href="${href}" rel="noopener noreferrer">${href}</a>).`);
    expect(rendered.html).toContain('href="https://example.test/wiki/Page_(one)"');
    expect(rendered.html).toContain('href="https://example.test/old" rel="noopener noreferrer">https://example.test/label</a>');
    expect(rendered.html).not.toContain('href="https://example.test/label"');
    expect(rendered.html).toContain('href="mailto:help@example.test"');
    expect(rendered.html).toContain("&lt;img&gt;");
    expect(rendered.text.split("\n")).toEqual(expect.arrayContaining([
      `${origin}/orders/demo?a=1&b=2`, "https://example.test/old", "https://example.test/wiki/Page_(one)",
    ]));
    expect(rendered.previewHtml).not.toMatch(/href=|<a /u);
  });

  it.each([
    "javascript:https://example.test/p",
    "data:text/html,https://example.test/p",
    "http://example.test/path",
    "mailto:help@example.test",
    "https://user:password@example.test/p",
    "https://example.test\\@other.example.test",
    "https://exam\u202Eple.test",
    "https://exam\u0001ple.test",
    `https://example.test/${"x".repeat(5000)}`,
  ])("does not make an anchor from invalid or non-HTTPS text %j", (raw) => {
    expect(plainTextToDeliveryHtml(raw)).not.toContain("<a ");
  });

  it("uses the normalized hostname as both the destination and visible URL", () => {
    const html = plainTextToDeliveryHtml("Review https://éxample.test/a?b=1&c=2.");
    const url = escapeHtmlText(new URL("https://éxample.test/a?b=1&c=2").href);
    expect(html).toContain(`<a href="${url}" rel="noopener noreferrer">${url}</a>.`);
  });

  it("keeps malformed markup rejected and blocks off-origin URLs in security mail", () => {
    const sample = {
      format: "html" as const, subjectTemplate: "Security notice", bodyTextTemplate: "Use {{link}}",
      declaredVars: ["link"], vars: { link: `${origin}/sign-in` }, canonicalOrigin: origin, lockedOrigin: origin,
    };
    expect(() => renderMailTemplateVersion({
      ...sample, bodyHtmlTemplate: '<p><a href="{{link}}"><a href="{{link}}">Nested</a></a></p>',
    })).toThrow();
    expect(() => renderMailTemplateVersion({
      ...sample, bodyHtmlTemplate: "<p>https://other.example.test/</p>",
    })).toThrow();
    expect(() => renderMailTemplateVersion({
      ...sample, bodyHtmlTemplate: '<p><a href="https://other.example.test/">Off origin</a></p>',
    })).toThrow();
    expect(renderMailTemplateVersion({
      ...sample, bodyHtmlTemplate: "<p>https://my.readypackets.test/sign-in?x=1&amp;y=2</p>",
    }).html).toContain('href="https://my.readypackets.test/sign-in?x=1&amp;y=2"');
  });
});
