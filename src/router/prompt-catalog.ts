import { FCI_EXPLANATION_OUTPUT_SCHEMA } from "../contracts/fci.js";
import { IMPLEMENTATION_REPORT_JSON_SCHEMA } from "../contracts/implementation.js";
import {
  type AiRole,
  type RolePrompts,
  RolePromptsSchema,
  appendRoleInstructions,
} from "../contracts/prompts.js";
import { PLAN_JSON_SCHEMA } from "../pm/plan.js";
import { buildPlanningPrompt, buildPmSystemPrompt } from "../pm/prompt.js";
import { buildFciExplanationPrompt } from "../worker/fci-prompt.js";
import { buildImplementPrompt, buildImplementSystemPrompt } from "../worker/prompt.js";

const builders = {
  planning: buildPmSystemPrompt,
  implementation: buildImplementSystemPrompt,
  fci_analysis: buildFciExplanationPrompt,
};

export function roleSystemPrompt(role: AiRole, prompts: RolePrompts): string {
  return appendRoleInstructions(builders[role](), prompts[role].additionalInstructions);
}

/** Current built-in instructions, using the same builders as execution. Examples contain no issue data. */
export function getPromptCatalog(prompts = RolePromptsSchema.parse({})) {
  return {
    roles: [
      {
        id: "planning",
        title: "플랜",
        description:
          "요구사항을 분석하고 서브태스크·의존성·완료 조건·검증 방법을 정의합니다. 판단이 필요하면 질문합니다.",
        source: "src/pm/prompt.ts",
        systemPrompt: buildPmSystemPrompt(),
        examplePrompt: buildPlanningPrompt({
          issue: { key: "EXAMPLE-1", summary: "{{이슈 제목}}", description: "{{이슈 설명}}" },
          comments: [{ authorDisplayName: "{{댓글 작성자}}", body: "{{댓글}}" }],
          existingSubtasks: [
            { key: "EXAMPLE-2", statusName: "{{현재 상태}}", summary: "{{기존 하위 작업}}" },
          ],
          humanDecision: { raw: "{{이전 결정 요청에 대한 인간 답변}}" },
        }),
        outputSchema: PLAN_JSON_SCHEMA,
      },
      {
        id: "implementation",
        title: "구현",
        description: "할당된 서브태스크나 간단한 작업을 구현하고 검증합니다.",
        source: "src/worker/prompt.ts",
        systemPrompt: buildImplementSystemPrompt(),
        examplePrompt: buildImplementPrompt({
          title: "{{작업 제목}}",
          description: "{{작업 설명}}",
          contract: {
            acceptance: ["{{완료 조건}}"],
            verification: ["{{검증 방법}}"],
            inScope: ["{{범위 안}}"],
            outOfScope: ["{{범위 밖}}"],
            affectedAreas: ["{{예상 변경 영역}}"],
            allowedPaths: ["{{허용 경로}}"],
            constraints: ["{{제약}}"],
          },
        }),
        outputSchema: IMPLEMENTATION_REPORT_JSON_SCHEMA,
      },
      {
        id: "fci_analysis",
        title: "FCI 변경 설명",
        description:
          "선택한 커밋의 정적 평가 근거와 개선 우선순위를 설명합니다. AI는 점수를 변경하지 않으며 승인과 상태 전이를 차단하지 않습니다.",
        source: "src/worker/fci-prompt.ts",
        systemPrompt: buildFciExplanationPrompt(),
        examplePrompt: JSON.stringify(
          {
            snapshotSha: "{{평가 SHA}}",
            facts: "{{결정적으로 수집한 관측값}}",
            tests: "{{검증 여부·근거}}",
          },
          null,
          2,
        ),
        outputSchema: FCI_EXPLANATION_OUTPUT_SCHEMA,
      },
    ].map((role) => ({
      ...role,
      additionalInstructions: prompts[role.id as AiRole].additionalInstructions,
      effectiveSystemPrompt: roleSystemPrompt(role.id as AiRole, prompts),
    })),
  };
}
