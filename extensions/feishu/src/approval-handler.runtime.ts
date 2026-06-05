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
};

const APPROVAL_RESOLVED_NOTE = "✅ Approval resolved.";
const APPROVAL_EXPIRED_NOTE = "⌛ Approval expired.";

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
  for (const button of buttons) {
    const element = buildFeishuPayloadButton(button);
    if (element) {
      elements.push(element);
    }
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

function stripCardButtons(card: Record<string, unknown>, note: string): Record<string, unknown> {
  const body = (card.body as { elements?: unknown[] } | undefined) ?? {};
  const elements = Array.isArray(body.elements) ? body.elements : [];
  const filtered = elements.filter((element) => {
    if (!element || typeof element !== "object") {
      return true;
    }
    return (element as { tag?: unknown }).tag !== "button";
  });
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
    buildResolvedResult: () => ({ kind: "clear-actions" }),
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
      const note = phase === "expired" ? APPROVAL_EXPIRED_NOTE : APPROVAL_RESOLVED_NOTE;
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
