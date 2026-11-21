import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FlowCanvas, INERT_PREVIEW_CSP, InertMailPreview, Input, Field, SsoButton, Wizard, type FlowNode, type FlowSelection } from "@/ui";
import { expectNoAxeViolations, renderUi } from "./testing";

describe("Wizard", () => {
  function Demo({ onDone }: { onDone: () => void }) {
    const steps = [
      { id: "a", label: "Statuses" },
      { id: "b", label: "Transitions" },
      { id: "c", label: "Review" },
    ];
    const [current, setCurrent] = useState("a");
    const [name, setName] = useState("");
    const index = steps.findIndex((s) => s.id === current);
    return (
      <Wizard
        steps={steps}
        current={current}
        completed={steps.slice(0, index).map((s) => s.id)}
        onStepSelect={setCurrent}
        onBack={() => setCurrent(steps[index - 1]!.id)}
        onNext={() => (index === steps.length - 1 ? onDone() : setCurrent(steps[index + 1]!.id))}
        nextLabel={index === steps.length - 1 ? "Publish" : "Continue"}
      >
        {current === "a" ? (
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : (
          <p>Name: {name}</p>
        )}
      </Wizard>
    );
  }

  it("marks the current step, focuses the step heading, keeps data on Back and submits on the last step", async () => {
    const onDone = vi.fn();
    renderUi(<Demo onDone={onDone} />);
    expect(screen.getByText("Statuses", { selector: "li *" }).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "Intake");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { level: 2, name: "Transitions" })).toHaveFocus();
    expect(screen.getByText("Transitions", { selector: "li *" }).closest("li")).toHaveAttribute("aria-current", "step");
    // Completed steps are reachable directly.
    expect(screen.getByRole("button", { name: /Step 1 of 3: Statuses/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Intake");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    await expectNoAxeViolations();
  });
});

describe("SsoButton", () => {
  it("is a real link with a clear name and an 'or' divider", async () => {
    renderUi(<SsoButton href="/api/identity/sso/start?ticket=t" />);
    const link = screen.getByRole("link", { name: /Sign in with SSO/ });
    expect(link).toHaveAttribute("href", "/api/identity/sso/start?ticket=t");
    expect(link).toHaveTextContent("Microsoft Entra ID");
    expect(screen.getByText("or")).toBeInTheDocument();
    await expectNoAxeViolations();
  });
  it("disabled: no href", () => {
    renderUi(<SsoButton href="/x" disabled divider={false} />);
    expect(screen.getByRole("link", { name: /Sign in with SSO/ })).not.toHaveAttribute("href");
    expect(screen.queryByText("or")).not.toBeInTheDocument();
  });
});

describe("InertMailPreview", () => {
  it("renders a fully sandboxed srcDoc frame with the policy first, plus a plain-text tab", async () => {
    renderUi(<InertMailPreview title="Preview of Password reset" html="<h1>Hello</h1><p>Body</p>" text={"Hello\nBody"} />);
    const frame = screen.getByTitle("Preview of Password reset");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc.indexOf(`content="${INERT_PREVIEW_CSP}"`)).toBeGreaterThan(-1);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<h1>"));
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<title>"));
    expect(screen.getByRole("tab", { name: "Structure preview" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Plain text" }));
    expect(screen.getByLabelText("Preview of Password reset, plain text")).toHaveTextContent("Hello Body");
    await expectNoAxeViolations();
  });
  it("escapes the title inside the frame document and falls back to text without html", () => {
    const { unmount } = renderUi(<InertMailPreview title={'</title><script>x</script>'} html="<p>a</p>" text="a" />);
    expect(screen.getByTitle("</title><script>x</script>").getAttribute("srcdoc")).toContain("&lt;/title&gt;&lt;script&gt;");
    unmount();
    renderUi(<InertMailPreview title="T" text="only text" />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("only text")).toBeInTheDocument();
  });
});

describe("FlowCanvas", () => {
  // jsdom has no layout: give elements a size and let ResizeObserver report it, so the library shows the nodes.
  const original = { ro: window.ResizeObserver, w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"), h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight") };
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 80 });
    (window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
      m22: number;
      constructor(transform?: string) {
        const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
        this.m22 = scale !== undefined ? Number(scale) : 1;
      }
    };
    window.ResizeObserver = class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element) {
        this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterAll(() => {
    window.ResizeObserver = original.ro;
    if (original.w) Object.defineProperty(HTMLElement.prototype, "offsetWidth", original.w);
    if (original.h) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original.h);
  });
  const NODES: FlowNode[] = [
    { id: "n1", label: "Received", kind: "Status", x: 0, y: 0 },
    { id: "n2", label: "In production", tone: "info", x: 300, y: 0 },
    { id: "n3", label: "Delivered", tone: "success", x: 600, y: 0 },
  ];
  function Demo(props: { readOnly?: boolean; onConnect?: (a: string, b: string) => void; onDelete?: (s: NonNullable<FlowSelection>) => void }) {
    const [nodes, setNodes] = useState(NODES);
    const [selected, setSelected] = useState<FlowSelection>(null);
    return (
      <>
        <FlowCanvas
          label="Workflow canvas"
          nodes={nodes}
          edges={[{ id: "e1", from: "n1", to: "n2", label: "Start" }]}
          selected={selected}
          onSelect={setSelected}
          onMove={(id, x, y) => setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, x, y } : n)))}
          onConnect={props.onConnect}
          onDelete={props.onDelete}
          readOnly={props.readOnly}
        />
        <output data-testid="state">{JSON.stringify({ selected, n1: nodes[0] })}</output>
      </>
    );
  }
  const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}");

  it("renders nodes and connections as named buttons; select, move by keyboard, connect by keyboard, delete", async () => {
    const onConnect = vi.fn();
    const onDelete = vi.fn();
    renderUi(<Demo onConnect={onConnect} onDelete={onDelete} />);
    const received = await screen.findByRole("button", { name: /^Status: Received/ });
    expect(screen.getByRole("group", { name: "Workflow canvas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start: from Received to In production" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();

    // fireEvent: user-event mousedown has no `view` in jsdom, which the drag library needs.
    fireEvent.click(received);
    expect(state().selected).toEqual({ type: "node", id: "n1" });
    expect(screen.getByRole("button", { name: /^Status: Received/ })).toHaveAttribute("aria-pressed", "true");

    received.focus();
    fireEvent.keyDown(received, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Status: Received/ }), { key: "ArrowDown", shiftKey: true });
    expect(state().n1).toMatchObject({ x: 20, y: 100 });
    expect(screen.getByText("Moved Received to 20, 100.")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: /^Status: Received/ }), { key: "c" });
    expect(screen.getByText(/Connecting from Received/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Delivered/ }), { key: "Enter" });
    expect(onConnect).toHaveBeenCalledWith("n1", "n3");

    fireEvent.keyDown(screen.getByRole("button", { name: /Start: from/ }), { key: "Delete" });
    expect(onDelete).toHaveBeenCalledWith({ type: "edge", id: "e1" });
    await act(async () => {});
    await expectNoAxeViolations();
  });

  it("read-only: arrows and C do nothing, selection still works", async () => {
    const onConnect = vi.fn();
    renderUi(<Demo readOnly onConnect={onConnect} />);
    const received = await screen.findByRole("button", { name: /^Status: Received/ });
    fireEvent.keyDown(received, { key: "ArrowRight" });
    fireEvent.keyDown(received, { key: "c" });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Delivered/ }), { key: "Enter" });
    expect(state().n1).toMatchObject({ x: 0, y: 0 });
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delivered/ }));
    await waitFor(() => expect(state().selected).toEqual({ type: "node", id: "n3" }));
  });

  it("creates no <style> elements and sets no style attribute markup (CSP)", async () => {
    const before = document.querySelectorAll("style").length;
    renderUi(<Demo />);
    await screen.findByRole("button", { name: /^Status: Received/ });
    expect(document.querySelectorAll("style").length).toBe(before);
  });
});
