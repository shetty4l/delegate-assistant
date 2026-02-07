import type { ExecutionPlanDraft, PolicyDecision } from "@delegate/domain";
import type { PolicyEngine } from "@delegate/ports";

export class DefaultPolicyEngine implements PolicyEngine {
  async evaluate(plan: ExecutionPlanDraft): Promise<PolicyDecision> {
    if (
      plan.requiresApproval ||
      plan.riskLevel === "HIGH" ||
      plan.riskLevel === "CRITICAL"
    ) {
      return {
        decision: "requires_approval",
        reasonCode: "MISSING_APPROVAL",
      };
    }

    return {
      decision: "allow",
      reasonCode: "LOW_RISK_ALLOWED",
    };
  }
}
