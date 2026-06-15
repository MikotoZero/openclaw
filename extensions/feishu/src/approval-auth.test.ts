import { describe, expect, it } from "vitest";
import { feishuApprovalAuth } from "./approval-auth.js";

describe("feishuApprovalAuth", () => {
  it("falls back to commands.ownerAllowFrom for approval approvers", () => {
    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: {
          commands: { ownerAllowFrom: ["feishu:ou_owner"] },
          channels: { feishu: { allowFrom: ["ou_other"] } },
        },
        senderId: "ou_owner",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: {
          commands: { ownerAllowFrom: ["feishu:ou_owner"] },
          channels: { feishu: { allowFrom: ["ou_other"] } },
        },
        senderId: "ou_other",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Feishu.",
    });
  });

  it("ignores wildcard ingress entries as approval approvers", () => {
    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: {
          commands: { ownerAllowFrom: ["feishu:ou_owner"] },
          channels: { feishu: { allowFrom: ["*"] } },
        },
        senderId: "ou_attacker",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Feishu.",
    });
  });

  it("authorizes open_id approvers and ignores user_id-only allowlists", () => {
    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: { channels: { feishu: { allowFrom: ["ou_owner"] } } },
        senderId: "ou_owner",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: { channels: { feishu: { allowFrom: ["user_123"] } } },
        senderId: "ou_attacker",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
