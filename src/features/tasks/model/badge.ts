/* 侧栏计数：待处理未读条数、运行中的任务数。外壳常驻，同时负责记下“消失”的待处理条目。 */
import { useTasks } from "./tasks";
import { useInbox, useInboxSync } from "./inbox";

export function useInboxBadge() {
  const tasks = useTasks();
  const inbox = useInbox(tasks.rows, !tasks.loading);
  useInboxSync(inbox.all, inbox.ready);
  return { inbox: inbox.unread, tasks: tasks.rows.filter((t) => t.state === "running").length };
}
