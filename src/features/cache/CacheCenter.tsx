// Volo · Cache —— 中心区路由（集群总览 / 4 个 DDC 视图），移植自 page_cache.jsx center()。
import { useCache } from "./state/store";
import { Overview } from "./views/Overview";
import { DdcZen } from "./views/ddc/Zen";
import { DdcLegacy } from "./views/ddc/Legacy";
import { DdcPak } from "./views/ddc/Pak";
import { DdcPso } from "./views/ddc/Pso";

export function CacheCenter() {
  const { nav } = useCache();
  switch (nav) {
    case "ddc_zen":
      return <DdcZen />;
    case "ddc_legacy":
      return <DdcLegacy />;
    case "ddc_pak":
      return <DdcPak />;
    case "ddc_pso":
      return <DdcPso />;
    default:
      return <Overview />;
  }
}
