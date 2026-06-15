import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { feishuApprovalAuth, getFeishuApprovalApprovers } from "./approval-auth.js";
import { normalizeFeishuTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type FeishuOriginTarget = { to: string };

function resolveTurnSourceFeishuTarget(request: ApprovalRequest): FeishuOriginTarget | null {
  // Channel/account match is enforced upstream via doesApprovalRequestMatchChannelAccount;
  // here we only convert a turnSourceTo (if present) to a feishu chat id.
  const rawTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  if (!rawTo) {
    return null;
  }
  const normalized = normalizeFeishuTarget(rawTo);
  return normalized ? { to: normalized } : null;
}

function resolveSessionFeishuTarget(sessionTarget: { to: string }): FeishuOriginTarget | null {
  const normalized = normalizeFeishuTarget(sessionTarget.to);
  return normalized ? { to: normalized } : null;
}

const resolveFeishuOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "feishu",
  resolveTurnSourceTarget: resolveTurnSourceFeishuTarget,
  resolveSessionTarget: resolveSessionFeishuTarget,
});

const resolveFeishuApproverDmTargets = createChannelApproverDmTargetResolver({
  resolveApprovers: getFeishuApprovalApprovers,
  mapApprover: (approver) => ({ to: approver }),
});

export const feishuApprovalCapability: ChannelApprovalCapability = {
  ...feishuApprovalAuth,
  delivery: {
    // Plugin approvals delivered to feishu are handled by the native runtime
    // (sends a card, clears buttons on resolve). Suppress the generic
    // outbound forwarding fallback so the user does not see a duplicate card.
    shouldSuppressForwardingFallback: ({ approvalKind, target }) => {
      if (approvalKind !== "plugin") {
        return false;
      }
      const channel = normalizeMessageChannel(target.channel) ?? target.channel;
      return channel === "feishu";
    },
  },
  native: {
    describeDeliveryCapabilities: ({ cfg, accountId }) => {
      const hasApproverDmTargets = getFeishuApprovalApprovers({ cfg, accountId }).length > 0;
      return {
        enabled: true,
        preferredSurface: hasApproverDmTargets ? "approver-dm" : "origin",
        supportsOriginSurface: true,
        supportsApproverDmSurface: hasApproverDmTargets,
        notifyOriginWhenDmOnly: hasApproverDmTargets,
      };
    },
    resolveOriginTarget: ({ cfg, accountId, approvalKind, request }) =>
      resolveFeishuOriginTarget({ cfg, accountId, approvalKind, request }),
    resolveApproverDmTargets: ({ cfg, accountId, approvalKind, request }) =>
      resolveFeishuApproverDmTargets({ cfg, accountId, approvalKind, request }),
  },
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["plugin"],
    // Channel/account match is enforced upstream when the framework calls
    // resolveOriginTarget; plugin approvals routed to feishu always reach here.
    isConfigured: () => true,
    shouldHandle: () => true,
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .feishuApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
  }),
};
