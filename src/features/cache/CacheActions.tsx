// Volo · Cache —— 上下文条里的集群概览（在线计数 + 快照提示），移植自 page_cache.jsx actions()。
// 新原型已把「立即巡检」从 ctxbar 移除：巡检入口收敛到集群总览 hero 条与健康段，避免重复。
import { Icon } from "./ui/Icon";
import { Button } from "./ui/Button";
import { Dot } from "./ui/status";
import { useMachines } from "./state/data";

export function CacheActions() {
  const { machines } = useMachines();
  const onlineCt = machines.filter((m) => m.status === "online").length;
  const total = machines.length;

  if (total === 0) {
    return (
      <div className="ctx-actions">
        <span className="snap-note" title="集群里还没有机器，巡检无从谈起">
          <Icon name="node" size={13} />
          空集群 · 先添加机器
        </span>
        <Button variant="secondary" size="S" icon={<Icon name="sync" size={15} />} isDisabled>
          立即巡检
        </Button>
      </div>
    );
  }

  return (
    <div className="ctx-actions">
      <div className="cluster-sum">
        <span className="sum-grp">
          <Dot visual="positive" />
          在线 <b>{onlineCt}</b>
          <span className="frac">/{total}</span>
        </span>
      </div>
      <span className="snap-note" title="状态为上次巡检的缓存快照，非实时轮询">
        <Icon name="eye" size={13} />
        快照
      </span>
    </div>
  );
}
