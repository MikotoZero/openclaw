import type { PendingApprovalView } from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildApprovalPresentationFromActionDescriptors,
  buildPluginApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  MessagePresentation,
  MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { buildFeishuPayloadButton } from "./outbound.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";

const log = createSubsystemLogger("feishu/approvals");

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

type FeishuApprovalPendingPayload = {
  text: string;
  card: Record<string, unknown>;
};

type FeishuApprovalPreparedTarget = {
  chatId: string;
};

type FeishuApprovalPendingEntry = {
  chatId: string;
  messageId: string;
  pendingCard: Record<string, unknown>;
  /** Stashed by buildResolvedResult so clearPendingActions (which only gets the
   *  phase) can render a decision-specific note. */
  decision?: string;
};

const APPROVAL_APPROVED_NOTE = "✅ 已批准";
const APPROVAL_DENIED_NOTE = "❌ 已拒绝";
const APPROVAL_RESOLVED_NOTE = "✅ 已处理";
const APPROVAL_EXPIRED_NOTE = "⌛ 已超时";
/** element_id tag on the button row's column_set so resolve can strip exactly
 *  the controls (by id) without guessing — and never touch content layout. */
const APPROVAL_ACTIONS_ELEMENT_ID = "codepilot-approval-actions";

function buildPendingText(params: {
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): string {
  if (params.approvalKind === "plugin") {
    // Use the plugin-supplied description as the card body — the buttons (added
    // in buildPendingPayload) replace the verbose "Title/Tool/Plugin/Agent/ID/
    // Reply with /approve" text frame. Title already shows in the card header.
    const description = (params.request as PluginApprovalRequest).request.description?.trim();
    return description && description.length > 0 ? description : params.view.title;
  }
  // Exec approval text is composed from the view's commandText/warning when
  // surfaced through the native runtime; fall back to the view title so the
  // card still describes the request even if upstream helpers change shape.
  const view = params.view;
  if (view.approvalKind !== "exec") {
    return view.title;
  }
  const lines: string[] = [];
  if (view.warningText) {
    lines.push(view.warningText);
  }
  lines.push(view.title);
  if (view.commandText) {
    lines.push("```sh", view.commandText, "```");
  }
  if (view.cwd) {
    lines.push(`cwd: \`${view.cwd}\``);
  }
  return lines.join("\n");
}

function buttonsFromPresentation(
  presentation: MessagePresentation | undefined,
): MessagePresentationButton[] {
  if (!presentation) {
    return [];
  }
  const block = presentation.blocks.find((entry) => entry.type === "buttons");
  return block?.type === "buttons" ? block.buttons : [];
}

function buildPresentationButtons(view: PendingApprovalView): MessagePresentationButton[] {
  return buttonsFromPresentation(buildApprovalPresentationFromActionDescriptors(view.actions));
}

function buildApprovalCard(params: {
  text: string;
  view: PendingApprovalView;
  /** Explicit buttons (plugin approvals pass the reply payload's presentation
   *  buttons here, since their view.actions is empty); falls back to the view's
   *  action descriptors (exec approvals). */
  buttons?: MessagePresentationButton[];
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [{ tag: "markdown", content: params.text }];
  const buttons = params.buttons ?? buildPresentationButtons(params.view);
  const buttonElements = buttons
    .map((button) => buildFeishuPayloadButton(button))
    .filter((element): element is Record<string, unknown> => element !== undefined);
  if (buttonElements.length > 0) {
    // Card schema 2.0 dropped `tag: action` (rejected as 200861). Lay buttons
    // out horizontally with a column_set — one button per equal-weight column.
    elements.push({
      tag: "column_set",
      element_id: APPROVAL_ACTIONS_ELEMENT_ID,
      flex_mode: "none",
      horizontal_spacing: "8px",
      columns: buttonElements.map((button) => ({
        // width:auto → each column hugs its button; columns pack left instead of
        // stretching to equal halves (which pushed Deny to the far right).
        tag: "column",
        width: "auto",
        elements: [button],
      })),
    });
  }
  const template =
    params.view.approvalKind === "plugin"
      ? params.view.severity === "critical"
        ? "red"
        : params.view.severity === "warning"
          ? "orange"
          : "blue"
      : "orange";
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: {
      title: { tag: "plain_text", content: params.view.title },
      template,
    },
    body: { elements },
  };
}

function isApprovalControl(element: unknown): boolean {
  if (!element || typeof element !== "object") {
    return false;
  }
  const entry = element as { tag?: unknown; element_id?: unknown };
  // The button row, tagged by element_id (precise — never a content element);
  // plus any stray top-level button as a defensive fallback.
  return entry.element_id === APPROVAL_ACTIONS_ELEMENT_ID || entry.tag === "button";
}

function stripCardButtons(card: Record<string, unknown>, note: string): Record<string, unknown> {
  const body = (card.body as { elements?: unknown[] } | undefined) ?? {};
  const elements = Array.isArray(body.elements) ? body.elements : [];
  // Drop only the decision controls (the element_id-tagged button row); all
  // content elements — including any non-button column_set layout — are kept.
  const filtered = elements.filter((element) => !isApprovalControl(element));
  filtered.push({ tag: "markdown", content: `<font color='grey'>${note}</font>` });
  return {
    ...card,
    body: { ...body, elements: filtered },
  };
}

export const feishuApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  FeishuApprovalPendingPayload,
  FeishuApprovalPreparedTarget,
  FeishuApprovalPendingEntry,
  never
>({
  eventKinds: ["plugin"],
  availability: {
    isConfigured: () => true,
    shouldHandle: () => true,
  },
  presentation: {
    buildPendingPayload: ({ request, approvalKind, nowMs, view }) => {
      const text = buildPendingText({ request, approvalKind, nowMs, view });
      if (approvalKind === "plugin") {
        // Plugin approvals: view.actions is empty, but the reply payload carries
        // a presentation with the decision buttons (value = /approve <id>
        // <decision>). Render those so the card has Approve/Deny buttons instead
        // of a "Reply with /approve" text instruction. Keep a grey id footer so
        // manual /approve still works if a button ever fails.
        const pluginRequest = request as PluginApprovalRequest;
        const payload = buildPluginApprovalPendingReplyPayload({
          request: pluginRequest,
          nowMs,
        });
        const buttons = buttonsFromPresentation(payload.presentation);
        const cardText = `${text}\n\n<font color='grey'>id: ${pluginRequest.id}</font>`;
        return {
          text,
          card: buildApprovalCard({ text: cardText, view, buttons }),
        };
      }
      return {
        text,
        card: buildApprovalCard({ text, view }),
      };
    },
    buildResolvedResult: ({ resolved, entry }) => {
      // Stash the decision on the shared entry so clearPendingActions (only gets
      // phase) can render approve vs deny. Same wrapped.entry instance is passed
      // to clearPendingActions next in the finalize loop.
      const decision = (resolved as { decision?: string } | undefined)?.decision;
      if (decision) {
        entry.decision = decision;
      }
      return { kind: "clear-actions" };
    },
    buildExpiredResult: () => ({ kind: "clear-actions" }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
      target: { chatId: plannedTarget.target.to },
    }),
    deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload }) => {
      const result = await sendCardFeishu({
        cfg,
        to: preparedTarget.chatId,
        card: pendingPayload.card,
        accountId: accountId ?? undefined,
      });
      return {
        chatId: preparedTarget.chatId,
        messageId: result.messageId,
        pendingCard: pendingPayload.card,
      };
    },
  },
  interactions: {
    clearPendingActions: async ({ cfg, accountId, entry, phase }) => {
      const note =
        phase === "expired"
          ? APPROVAL_EXPIRED_NOTE
          : entry.decision === "deny"
            ? APPROVAL_DENIED_NOTE
            : entry.decision
              ? APPROVAL_APPROVED_NOTE
              : APPROVAL_RESOLVED_NOTE;
      const clearedCard = stripCardButtons(entry.pendingCard, note);
      await updateCardFeishu({
        cfg,
        messageId: entry.messageId,
        card: clearedCard,
        accountId: accountId ?? undefined,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`feishu approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
