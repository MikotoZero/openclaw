import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelNativeOriginTargetResolver } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { feishuApprovalAuth } from "./approval-auth.js";
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
    // Channel/account match is enforced upstream when the framework calls
    // resolveOriginTarget; plugin approvals routed to feishu always reach here.
    isConfigured: () => true,
    shouldHandle: () => true,
    load: async () =>
      (await import("./approval-handler.runtime.js"))
        .feishuApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
  }),
};
