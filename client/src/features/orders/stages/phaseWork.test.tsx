import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { expect, it } from "vitest";
import type { ReactElement } from "react";
import type { AppRouter } from "@server/trpc/root";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, expectNoAxeViolations, renderUi } from "@/ui/testing";
import { AdminPhaseChecklist, StaffPhaseQuestions } from "./PhaseConsoleWork";
import { OrderPhaseConsolePanel } from "./OrderPhaseConsolePanel";
import { StageQuestions } from "./StageQuestions";

const orderId = "01J00000000000000000000002";
const questionId = "01J00000000000000000000003";
const userId = "01J00000000000000000000005";
const stageKey = "intake";
const date = new Date("2026-11-24T13:00:00Z");
const title = "Where should our team look?";
type Fixtures = Record<string, (input: unknown) => unknown>;
function renderPhase(ui: ReactElement, fixtures: Fixtures) {
  const queryClient = createTestQueryClient();
  const calls: { path: string; input: unknown }[] = [];
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc", transformer: superjson,
      fetch: async (request, options) => {
        const url = new URL(String(request));
        const data = JSON.parse((typeof options?.body === "string" ? options.body : url.searchParams.get("input")) ?? "{}") as
          Record<string, Parameters<typeof superjson.deserialize>[0]>;
        const results = url.pathname.slice("/rpc/".length).split(",").map((path, index) => {
          const raw = data[index];
          const input = raw ? superjson.deserialize(raw) : undefined;
          calls.push({ path, input });
          const handle = fixtures[path];
          return handle ? { result: { data: superjson.serialize(handle(input)) } }
            : { error: superjson.serialize({ message: "missing fixture", code: -32004, data: { code: "NOT_FOUND", path } }) };
        });
        return Response.json(results);
      },
    })],
  });
  const rendered = renderUi(<main><h1>Order</h1><h2>Customer phase workspace</h2>{ui}</main>, {
    queryClient, wrapper: (node) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{node}</TRPCProvider>,
  });
  return { ...rendered, calls };
}

it("answers, edits a new version, restores focus, and never renders message text as HTML", async () => {
  let answer: { body: string; version: number; answeredAt: Date } | null = null;
  const { calls } = renderPhase(<StageQuestions orderId={orderId} stageKey={stageKey} />, {
    "orders.questions.customerList": () => ({ canAnswer: true, questions: [{ questionId, prompt: title, required: true, askedAt: date, latestAnswer: answer }] }),
    "orders.questions.answer": (input) => {
      const draft = input as { body: string; expectedVersion: number };
      answer = { body: draft.body, version: draft.expectedVersion + 1, answeredAt: date };
      return { version: answer.version };
    },
  });
  const user = userEvent.setup();
  const question = await screen.findByRole("heading", { name: title });
  await user.click(screen.getByRole("button", { name: "Answer question" }));
  const input = screen.getByRole("textbox", { name: /Your answer/ });
  expect(input).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Save answer" }));
  expect(input).toHaveAccessibleDescription(/Enter an answer before saving/);
  await user.type(input, "<strong>First draft</strong>");
  await user.click(screen.getByRole("button", { name: "Save answer" }));
  expect(await screen.findByText("<strong>First draft</strong>")).toBeInTheDocument();
  await waitFor(() => expect(question).toHaveFocus());
  await user.click(screen.getByRole("button", { name: "Edit answer" }));
  const edit = screen.getByRole("textbox", { name: /Your answer/ });
  await user.clear(edit);
  await user.type(edit, "Second answer");
  await user.click(screen.getByRole("button", { name: "Save answer" }));
  expect(await screen.findByText("Second answer")).toBeInTheDocument();
  expect(calls.filter((call) => call.path === "orders.questions.answer").map((call) => call.input)).toEqual([
    { orderId, stageKey, questionId, expectedVersion: 0, body: "<strong>First draft</strong>" },
    { orderId, stageKey, questionId, expectedVersion: 1, body: "Second answer" },
  ]);
  await expectNoAxeViolations(document.body);
});

it("keeps completed customer questions readable without edit actions", async () => {
  renderPhase(<StageQuestions orderId={orderId} stageKey={stageKey} readOnly headingLevel={4} />, {
    "orders.questions.customerList": () => ({ canAnswer: true, questions: [{
      questionId, prompt: title, required: true, askedAt: date, latestAnswer: { version: 1, body: "Existing answer", answeredAt: date },
    }] }),
  });
  expect(await screen.findByText("Existing answer")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Questions from our team", level: 4 })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: title, level: 5 })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit answer" })).not.toBeInTheDocument();
});

it("opens paginated staff answer history and persists an audited checklist change via the server", async () => {
  let checked = false;
  let version = 0;
  const { calls } = renderPhase(<><StaffPhaseQuestions orderId={orderId} stageKey={stageKey} /><AdminPhaseChecklist orderId={orderId} stageKey={stageKey} /></>, {
    "orders.questions.list": () => ({ canManage: true, questions: [{
      questionId, prompt: title, required: true, askedAt: date, withdrawnAt: null,
      latestAnswer: { version: 2, body: "Visible latest answer", answeredAt: date, answeredByPublicId: userId },
    }] }),
    "orders.questions.history": (input) => (input as { beforeVersion?: number }).beforeVersion
      ? { answers: [{ version: 1, body: "Previous answer", answeredAt: date, answeredByPublicId: userId }], nextBeforeVersion: null }
      : { answers: [{ version: 2, body: "Latest in history", answeredAt: date, answeredByPublicId: userId }], nextBeforeVersion: 2 },
    "orders.adminTasks.list": () => ({
      canManage: true, tasks: [{ taskKey: "review_submission", checkedAt: checked ? date : null, checkedByPublicId: checked ? userId : null, version }],
    }),
    "orders.adminTasks.set": (input) => {
      checked = (input as { checked: boolean }).checked;
      return { version: ++version, changed: true };
    },
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Show answer history" }));
  expect(await screen.findByText("Latest in history")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Older answers" }));
  expect(await screen.findByText("Previous answer")).toBeInTheDocument();
  const checkbox = screen.getByRole("checkbox", { name: "Review the submission" });
  checkbox.focus();
  await user.keyboard(" ");
  await waitFor(() => expect(checkbox).toBeChecked());
  expect(checkbox).toHaveFocus();
  expect(calls.find((call) => call.path === "orders.adminTasks.set")?.input)
    .toEqual({ orderId, stageKey, taskKey: "review_submission", checked: true, expectedVersion: 0 });
  await expectNoAxeViolations(document.body);
});

it("records changes requested and requires a reason and confirmation before reopening", async () => {
  const intake = {
    key: stageKey, staffLabel: "Intake review", customerLabel: "Intake", index: 0, state: "submitted",
    completed: false, locked: true, viewable: true, actions: { answerQuestions: false },
    submittedAt: date.toISOString(), review: null, canReview: true, canReopen: true,
  };
  const { calls } = renderPhase(<OrderPhaseConsolePanel orderId={orderId} renderActions={() => <p>Phase actions slot</p>} />, {
    "orders.stages.workspace": () => ({ orderId, version: 5, currentStageKey: stageKey, derived: false, stages: [intake] }),
    "orders.stages.review": () => ({ version: 6 }),
    "orders.stages.reopen": () => ({ version: 7, progressPercent: 0 }),
  });
  const user = userEvent.setup();
  expect(await screen.findByText("Phase actions slot")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Request changes" }));
  const review = await screen.findByRole("dialog", { name: "Request changes" });
  await user.type(within(review).getByRole("textbox", { name: /What needs to change/ }), "Update the requested evidence.");
  await user.click(within(review).getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(review).not.toBeInTheDocument());
  expect(calls.find((call) => call.path === "orders.stages.review")?.input)
    .toEqual({ orderId, stageKey, expectedVersion: 5, outcome: "changes_requested", note: "Update the requested evidence." });

  await user.click(screen.getByRole("button", { name: "Reopen phase" }));
  const reopen = await screen.findByRole("dialog", { name: "Reopen phase" });
  const confirm = within(reopen).getByRole("button", { name: "Reopen phase" });
  const reason = within(reopen).getByRole("textbox", { name: /Reason for reopening/ });
  await user.click(confirm);
  expect(reason).toHaveAccessibleDescription(/at least 10 characters/);
  await user.type(reason, "The customer needs to add a missing file.");
  await user.click(confirm);
  const box = within(reopen).getByRole("checkbox", { name: /I confirm/ });
  expect(box).toHaveFocus();
  expect(calls.some((call) => call.path === "orders.stages.reopen")).toBe(false);
  await user.keyboard(" ");
  await user.click(confirm);
  await waitFor(() => expect(reopen).not.toBeInTheDocument());
  expect(calls.find((call) => call.path === "orders.stages.reopen")?.input)
    .toEqual({ orderId, stageKey, expectedVersion: 5, reason: "The customer needs to add a missing file.", confirm: true });
  await waitFor(() => expect(screen.getByRole("heading", { name: "Intake review" })).toHaveFocus());
});

it("keeps a derived phase readable without creating new question, checklist, or run controls", async () => {
  renderPhase(<OrderPhaseConsolePanel orderId={orderId} renderActions={() => <p>Phase actions slot</p>} />, {
    "orders.stages.workspace": () => ({
      orderId, version: 5, currentStageKey: stageKey, derived: true, stages: [{
        key: stageKey, staffLabel: "Legacy intake", customerLabel: "Intake", index: 0, state: "open",
        completed: false, locked: false, viewable: true, actions: { answerQuestions: false },
        submittedAt: null, review: null, canReview: false, canReopen: false,
      }],
    }),
    "orders.requirements.forOrder": () => ({ phases: [], uploads: [], acknowledgements: [], documents: [] }),
  });
  expect(await screen.findByRole("heading", { name: "Legacy intake" })).toBeInTheDocument();
  expect(screen.getByText("No submission recorded.")).toBeInTheDocument();
  expect(screen.queryByText("Phase actions slot")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Administrator checklist" })).not.toBeInTheDocument();
});

it("keeps the reviewed phase selected and focused when accepting advances the order", async () => {
  let accepted = false;
  const intake = {
    key: stageKey, staffLabel: "Intake review", customerLabel: "Intake", index: 0,
    completed: false, locked: true, viewable: true, actions: { answerQuestions: false },
    submittedAt: date.toISOString(), review: null, canReopen: false,
  };
  renderPhase(<OrderPhaseConsolePanel orderId={orderId} renderActions={() => null} />, {
    "orders.stages.workspace": () => ({
      orderId, version: accepted ? 6 : 5, currentStageKey: accepted ? "delivery" : stageKey, derived: false, stages: [
        { ...intake, state: accepted ? "accepted" : "submitted", completed: accepted, canReview: !accepted },
        { ...intake, key: "delivery", staffLabel: "Delivery", index: 1, state: accepted ? "open" : "future", canReview: false },
      ],
    }),
    "orders.stages.review": () => { accepted = true; return { version: 6 }; },
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Accept submission" }));
  const review = await screen.findByRole("dialog", { name: "Accept submission" });
  await user.click(within(review).getByRole("button", { name: "Accept submission" }));
  expect(await screen.findByRole("option", { name: "2. Delivery (current)" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Select a phase" })).toHaveValue(stageKey);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Intake review" })).toHaveFocus());
});

pageA11y("customer phase question editor", async () => {
  document.title = "Order phases | ReadyPackets";
  renderPhase(<StageQuestions orderId={orderId} stageKey={stageKey} />, {
    "orders.questions.customerList": () => ({ canAnswer: true, questions: [{
      questionId, prompt: title, required: true, askedAt: date, latestAnswer: null,
    }] }),
  });
  await userEvent.click(await screen.findByRole("button", { name: "Answer question" }));
  expect(screen.getByRole("textbox", { name: /Your answer/ })).toHaveFocus();
});
