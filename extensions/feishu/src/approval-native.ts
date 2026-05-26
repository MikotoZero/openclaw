import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelNativeOriginTargetResolver } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { feishuApprovalAuth } from "./approval-auth.js";
import { normalizeFeishuTarget } from "./targets.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type FeishuOriginTarget = { to: string };

function isFeishuApprovalRequest(request: ApprovalRequest): boolean {
  const channel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  return channel === "feishu" || channel === "lark";
}

function resolveTurnSourceFeishuTarget(request: ApprovalRequest): FeishuOriginTarget | null {
  if (!isFeishuApprovalRequest(request)) {
    return null;
  }
  const rawTo = normalizeOptionalString(request.request.turnSourceTo) ?? "";
  const normalized = rawTo ? normalizeFeishuTarget(rawTo) : null;
  return normalized ? { to: normalized } : null;
}

function resolveSessionFeishuTarget(sessionTarget: { to: string }): FeishuOriginTarget | null {
  const normalized = normalizeFeishuTarget(sessionTarget.to);
  return normalized ? { to: normalized } : null;
}

const resolveFeishuOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "feishu",
  shouldHandleRequest: ({ request }) => isFeishuApprovalRequest(request),
  resolveTurnSourceTarget: resolveTurnSourceFeishuTarget,
  resolveSessionTarget: resolveSessionFeishuTarget,
});

export const feishuApprovalCapability: ChannelApprovalCapability = {
  ...feishuApprovalAuth,
  native: {
    describeDeliveryCapabilities: () => ({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
    }),
    resolveOriginTarget: ({ cfg, accountId, approvalKind, request }) =>
      resolveFeishuOriginTarget({ cfg, accountId, approvalKind, request }),
  },
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    eventKinds: ["plugin"],
    isConfigured: () => true,
    shouldHandle: ({ request }) => isFeishuApprovalRequest(request),
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .feishuApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
  }),
};
