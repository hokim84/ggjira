import { IMPLEMENTATION_REPORT_JSON_SCHEMA } from "../contracts/implementation.js";
import { PLAN_JSON_SCHEMA } from "../pm/plan.js";
import { buildPlanningPrompt, buildPmSystemPrompt } from "../pm/prompt.js";
import { buildImplementPrompt, buildImplementSystemPrompt } from "../worker/prompt.js";

/** Current built-in instructions, using the same builders as execution. Examples contain no issue data. */
export function getPromptCatalog() {
  return {
    agents: [
      {
        id: "planning",
        title: "PM Agent",
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
        title: "구현 Agent",
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
    ],
  };
}
