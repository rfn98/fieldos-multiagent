import { runInvestigationWorkflow } from "./workflow/orchestrator";
import type { InvestigateResult } from "./types";
import type { InvestigateInput } from "./workflow/input";

export type { InvestigateInput } from "./workflow/input";

export async function investigate(input: InvestigateInput): Promise<InvestigateResult> {
  return runInvestigationWorkflow(input);
}
