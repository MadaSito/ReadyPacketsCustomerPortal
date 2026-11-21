import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RichTextEditor, isAllowedMailHref, isAllowedMailImageSrc } from "@/ui";
import { fromEditorHtml, toEditorHtml } from "./editor/html";
import { expectNoAxeViolations, renderUi } from "./testing";

beforeAll(() => {
  // ProseMirror measures selections; jsdom has no layout.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getBoundingClientRect ??= () => rect;
  Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint ??= () => null;
});

describe("mail HTML subset helpers", () => {
  it("accepts https, mailto and exactly one variable as href; https only for images", () => {
    expect(isAllowedMailHref("https://example.com/a")).toBe(true);
    expect(isAllowedMailHref("mailto:help@example.com")).toBe(true);
    expect(isAllowedMailHref("{{resetLink}}")).toBe(true);
    for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "/relative", "{{a}}{{b}}", "https://x y", "//evil.example"]) {
      expect(isAllowedMailHref(bad)).toBe(false);
    }
    expect(isAllowedMailImageSrc("https://cdn.example.com/logo.png")).toBe(true);
    expect(isAllowedMailImageSrc("http://cdn.example.com/logo.png")).toBe(false);
    expect(isAllowedMailImageSrc("data:image/png;base64,AAA")).toBe(false);
  });
  it("round-trips variables as chips and keeps output in the subset", () => {
    const editor = toEditorHtml('<p>Hello {{ firstName }}, <a href="{{resetLink}}">reset</a></p>');
    expect(editor).toContain('<span data-variable="firstName"></span>');
    expect(editor).toContain('href="{{resetLink}}"');
    const out = fromEditorHtml(
      '<p class="x" style="color:red">Hi <span data-variable="firstName" class="rp-variable-chip">{{firstName}}</span> <a href="javascript:x">bad</a> <a href="https://ok.example" target="_blank" rel="noopener">ok</a></p>' +
        '<script>x()</script><img src="http://insecure.example/a.png" alt="a"><img src="https://ok.example/b.png" alt="Logo" title="t"><a href="{{actionUrl}}" data-rp-button="yes">Go</a><u>under</u>',
    );
    expect(out).toBe(
      '<p>Hi {{firstName}} bad <a href="https://ok.example">ok</a></p><img src="https://ok.example/b.png" alt="Logo"><a href="{{actionUrl}}" data-rp-button="primary">Go</a>under',
    );
    expect(fromEditorHtml("<p></p>")).toBe("");
  });
});

describe("RichTextEditor", () => {
  function Demo({ onChange, initial = "<p>Hello {{firstName}}</p>" }: { onChange: (html: string) => void; initial?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <RichTextEditor
        label="Message body"
        hint="Shown to the recipient."
        value={value}
        onChange={(html) => {
          setValue(html);
          onChange(html);
        }}
        variables={[
          { name: "firstName", label: "First name" },
          { name: "resetLink", label: "Reset link", required: true },
        ]}
      />
    );
  }

  it("is a labelled multi-line textbox with a formatting toolbar, chips for variables and no injected <style>", async () => {
    const before = document.querySelectorAll("style").length;
    renderUi(<Demo onChange={vi.fn()} />);
    const box = await screen.findByRole("textbox", { name: "Message body" });
    expect(box).toHaveAttribute("aria-multiline", "true");
    expect(box).toHaveAccessibleDescription("Shown to the recipient.");
    expect(box.querySelector('[data-variable="firstName"]')).toHaveTextContent("{{firstName}}");
    const toolbar = screen.getByRole("toolbar", { name: "Message body: formatting" });
    expect(toolbar).toBeInTheDocument();
    for (const name of ["Heading 2", "Heading 3", "Bold", "Italic", "Bulleted list", "Numbered list", "Link", "Button", "Image"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // One Tab stop for the toolbar (roving tabindex).
    const tools = Array.from(toolbar.querySelectorAll<HTMLElement>("[data-rp-tool]:not(:disabled)"));
    expect(tools.filter((el) => el.tabIndex === 0)).toHaveLength(1);
    expect(document.querySelectorAll("style").length).toBe(before);
    expect(document.querySelector("style[data-tiptap-style]")).toBeNull();
    await expectNoAxeViolations();
  });

  it("toolbar buttons format the content and report pressed state", async () => {
    const onChange = vi.fn();
    renderUi(<Demo onChange={onChange} />);
    await screen.findByRole("textbox", { name: "Message body" });
    fireEvent.click(screen.getByRole("button", { name: "Heading 2" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("<h2>Hello {{firstName}}</h2>"));
    expect(screen.getByRole("button", { name: "Heading 2" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Bulleted list" }));
    await waitFor(() => expect(onChange.mock.lastCall?.[0]).toContain("<ul><li>"));
  });

  it("inserts a button whose target is a variable, and refuses a non-https image", async () => {
    const onChange = vi.fn();
    renderUi(<Demo onChange={onChange} initial="" />);
    await screen.findByRole("textbox", { name: "Message body" });
    fireEvent.click(screen.getByRole("button", { name: "Button" }));
    const dialog = await screen.findByRole("dialog", { name: "Insert button" });
    await userEvent.type(screen.getByLabelText(/^Address/), "{{{{resetLink}}");
    await userEvent.type(screen.getByLabelText(/^Button text/), "Reset password");
    await userEvent.click(screen.getByRole("button", { name: "Insert button" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(onChange.mock.lastCall?.[0]).toContain('<a href="{{resetLink}}" data-rp-button="primary">Reset password</a>');

    fireEvent.click(screen.getByRole("button", { name: "Image" }));
    await screen.findByRole("dialog", { name: "Insert image" });
    await userEvent.type(screen.getByLabelText(/^Image address/), "http://insecure.example/a.png");
    await userEvent.type(screen.getByLabelText(/^Description/), "Logo");
    await userEvent.click(screen.getByRole("button", { name: "Insert image" }));
    expect(within(screen.getByRole("dialog", { name: "Insert image" })).getByRole("alert")).toHaveTextContent("https://");
  });

  it("applies a new value from the parent without echoing onChange", async () => {
    const onChange = vi.fn();
    function Parent() {
      const [value, setValue] = useState("<p>One</p>");
      return (
        <>
          <button type="button" onClick={() => setValue("<p>Two {{x}}</p>")}>
            Load
          </button>
          <RichTextEditor label="Body" value={value} onChange={onChange} />
        </>
      );
    }
    renderUi(<Parent />);
    const box = await screen.findByRole("textbox", { name: "Body" });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    await waitFor(() => expect(box).toHaveTextContent("Two {{x}}"));
    expect(box.querySelector('[data-variable="x"]')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

});
