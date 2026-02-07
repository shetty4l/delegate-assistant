import type {
  ExecutionPlanDraft,
  GenerateInput,
  GenerateResult,
} from "@delegate/domain";
import type { ModelPort, PlanInput } from "@delegate/ports";

const includesAny = (text: string, needles: string[]): boolean =>
  needles.some((needle) => text.includes(needle));

export class DeterministicModelStub implements ModelPort {
  async plan(input: PlanInput): Promise<ExecutionPlanDraft> {
    const normalized = input.text.toLowerCase();

    const highRisk = includesAny(normalized, [
      "publish",
      "pr",
      "merge",
      "deploy",
      "delete",
      "send",
    ]);

    return {
      intentSummary: `Plan delegated request: ${input.text.slice(0, 140)}`,
      assumptions: [
        "Repository access and local tooling are available.",
        "Proposed changes will be validated before external publish.",
      ],
      ambiguities: ["Exact acceptance criteria may need confirmation."],
      proposedNextStep: highRisk
        ? "Review the proposed patch and request approval before publish."
        : "Review the plan and confirm implementation scope.",
      riskLevel: highRisk ? "HIGH" : "MEDIUM",
      sideEffects: highRisk
        ? ["local_code_changes", "external_publish"]
        : ["local_code_changes"],
      requiresApproval: highRisk,
    };
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const fileName = `delegate-work-items/${input.workItemId}.md`;
    const sections = [
      `# Work Item ${input.workItemId}`,
      "",
      `Intent: ${input.plan.intentSummary}`,
      "",
      "## Requested Task",
      input.text,
      "",
      "## Proposed Next Step",
      input.plan.proposedNextStep,
      "",
      "## Assumptions",
      ...input.plan.assumptions.map((assumption) => `- ${assumption}`),
    ];

    return {
      artifact: {
        path: fileName,
        content: sections.join("\n"),
        summary: "Generated deterministic work item markdown artifact.",
      },
    };
  }
}
