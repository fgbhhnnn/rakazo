/** Background workers are named "<main bot> · 后台<slot>" (see background-tasks.ts). */
const WORKER_NAME = / · 后台\d+$/;

export function isBackgroundWorkerName(name: string): boolean {
  return WORKER_NAME.test(name);
}

/**
 * A worker's name as the dispatcher's model may see it. The slot number is internal: a model that
 * sees "后台1" repeats it to the user ("由后台1执行") and, since one slot runs task after task, can
 * credit a result to the slot's previous task. Tasks are named by title and #ref instead.
 */
export function withoutWorkerSlot(name: string): string {
  return name.replace(WORKER_NAME, " · 后台任务");
}
