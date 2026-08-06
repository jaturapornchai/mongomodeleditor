import type { Workflow, WorkflowStep, WorkflowTransition } from "../workflow";

export type WorkflowDoor = {
  transition: WorkflowTransition;
  target: WorkflowStep;
  label: string;
};

export type WorkflowRoom = {
  step: WorkflowStep;
  doors: WorkflowDoor[];
};

export function workflowEntry(workflow: Workflow, preferred?: string): string | null {
  if (preferred && workflow.steps.some((step) => step.id === preferred)) return preferred;
  return workflow.steps.find((step) => step.kind === "start")?.id ?? workflow.steps[0]?.id ?? null;
}

export function workflowRoom(workflow: Workflow, stepId: string): WorkflowRoom | null {
  const step = workflow.steps.find((item) => item.id === stepId);
  if (!step) return null;
  const byId = new Map(workflow.steps.map((item) => [item.id, item]));
  const doors = workflow.transitions.flatMap((transition) => {
    if (transition.source !== stepId) return [];
    const target = byId.get(transition.target);
    if (!target) return [];
    return [{
      transition,
      target,
      label: transition.label?.trim() || transition.condition?.trim() || target.title,
    }];
  });
  return { step, doors };
}

export function workflowCityPositions(workflow: Workflow): Map<string, { x: number; z: number }> {
  if (!workflow.steps.length) return new Map();
  const xs = workflow.steps.map((step) => step.position.x);
  const ys = workflow.steps.map((step) => step.position.y);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  return new Map(workflow.steps.map((step) => [step.id, {
    x: (step.position.x - centerX) / 80,
    z: (step.position.y - centerY) / 80,
  }]));
}

/** หาเส้นทางสั้นสุดบนถนน workflow; เดินย้อนทางได้เพื่อสำรวจผังแบบ SimCity */
export function workflowPath(workflow: Workflow, source: string, target: string): string[] | null {
  const ids = new Set(workflow.steps.map((step) => step.id));
  if (!ids.has(source) || !ids.has(target)) return null;
  if (source === target) return [source];
  const neighbors = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const transition of workflow.transitions) {
    if (!ids.has(transition.source) || !ids.has(transition.target)) continue;
    neighbors.get(transition.source)!.push(transition.target);
    neighbors.get(transition.target)!.push(transition.source);
  }
  const previous = new Map<string, string | null>([[source, null]]);
  const queue = [source];
  for (let index = 0; index < queue.length && !previous.has(target); index += 1) {
    const current = queue[index];
    for (const next of neighbors.get(current) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!previous.has(target)) return null;
  const path: string[] = [];
  for (let current: string | null = target; current !== null; current = previous.get(current) ?? null)
    path.push(current);
  return path.reverse();
}
