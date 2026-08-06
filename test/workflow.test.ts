import test from "node:test";
import assert from "node:assert/strict";
import {
  blankWorkflow,
  lintWorkflow,
  loginWorkflowTemplate,
  workflowInputError,
  workflowToMarkdown,
  workflowToMermaid,
} from "../app/workflow";
import { layoutWorkflow } from "../app/workflow-layout";
import { workflowCityPositions, workflowEntry, workflowPath, workflowRoom } from "../app/workflow-3d/world";

test("login workflow is structurally valid and exportable for vibe coding", () => {
  const workflow = loginWorkflowTemplate();
  assert.equal(workflowInputError(workflow), null);
  assert.equal(lintWorkflow(workflow).some((issue) => issue.level === "error"), false);

  const markdown = workflowToMarkdown(workflow);
  assert.match(markdown, /POST \/api\/auth\/login/);
  assert.match(markdown, /Acceptance Criteria/);
  assert.match(markdown, /HttpOnly/);

  const mermaid = workflowToMermaid(workflow);
  assert.match(mermaid, /^flowchart TD/m);
  assert.match(mermaid, /ข้อมูลถูกต้อง\?/);
  assert.match(mermaid, /-->/);
});

test("workflow validation rejects dangling transitions and reserved ids", () => {
  const dangling = blankWorkflow();
  dangling.transitions[0].target = "missing";
  assert.match(workflowInputError(dangling) ?? "", /\[WORKFLOW_TRANSITION_DANGLING\]/);

  const reserved = blankWorkflow();
  reserved.id = "__proto__";
  assert.match(workflowInputError(reserved) ?? "", /\[WORKFLOW_ID_INVALID\]/);
});

test("workflow lint resolves stable collection and field ids", () => {
  const workflow = blankWorkflow();
  workflow.steps[0].dataAccess = [{ collection: "users-id", fields: ["email-id"], operation: "read" }];
  assert.ok(lintWorkflow(workflow).some((issue) => issue.rule === "workflow-collection-missing"));
  assert.equal(
    lintWorkflow(workflow, {
      "users-id": { label: "users", fields: { "email-id": "email" } },
    }).some((issue) => issue.rule === "workflow-collection-missing" || issue.rule === "workflow-field-missing"),
    false,
  );
});

test("workflow auto-layout places connected steps from top to bottom", async () => {
  const positions = await layoutWorkflow(
    [{ id: "start" }, { id: "action" }, { id: "isolated" }],
    [{ id: "t1", source: "start", target: "action" }],
  );
  assert.equal(positions.size, 3);
  assert.ok((positions.get("start")?.y ?? Infinity) < (positions.get("action")?.y ?? -Infinity));
  assert.notDeepEqual(positions.get("start"), positions.get("action"));
});

test("workflow 3D city preserves branches and finds walking routes", () => {
  const workflow = loginWorkflowTemplate();
  const positions = workflowCityPositions(workflow);
  assert.equal(workflowEntry(workflow), "start");
  assert.equal(workflowEntry(workflow, "verify"), "verify");
  assert.notDeepEqual(positions.get("start"), positions.get("verify"));
  for (const source of workflow.steps) for (const target of workflow.steps) {
    assert.equal(Math.sign((positions.get(source.id)?.x ?? 0) - (positions.get(target.id)?.x ?? 0)), Math.sign(source.position.x - target.position.x));
    assert.equal(Math.sign((positions.get(source.id)?.z ?? 0) - (positions.get(target.id)?.z ?? 0)), Math.sign(source.position.y - target.position.y));
  }
  assert.deepEqual(workflowPath(workflow, "start", "failure"), ["start", "input", "validate", "failure"]);

  const decision = workflowRoom(workflow, "validate");
  assert.deepEqual(decision?.doors.map((door) => door.label), ["ถูกต้อง", "ไม่ถูกต้อง"]);
  assert.deepEqual(decision?.doors.map((door) => door.target.id), ["request", "failure"]);

  workflow.transitions.push({ id: "retry", source: "failure", target: "input", label: "ลองใหม่" });
  assert.equal(workflowRoom(workflow, "failure")?.doors[0]?.target.id, "input");
  assert.deepEqual(workflowPath(workflow, "failure", "start"), ["failure", "input", "start"]);
});
