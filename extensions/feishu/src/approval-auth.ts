import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveFeishuAccount } from "./accounts.js";
import { normalizeFeishuTarget } from "./targets.js";

export function normalizeFeishuApproverId(value: string | number): string | undefined {
  const normalized = normalizeFeishuTarget(String(value));
  const trimmed = normalizeOptionalLowercaseString(normalized);
  return trimmed?.startsWith("ou_") ? trimmed : undefined;
}

export function getFeishuApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId }).config;
  return resolveApprovalApprovers({
    explicit: params.cfg.commands?.ownerAllowFrom,
    allowFrom: account.allowFrom,
    normalizeApprover: normalizeFeishuApproverId,
  });
}

export const feishuApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Feishu",
  resolveApprovers: getFeishuApprovalApprovers,
  normalizeSenderId: (value) => normalizeFeishuApproverId(value),
});
