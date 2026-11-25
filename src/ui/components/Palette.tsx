/* Command Palette（⌘K）：对象 / 命令 / 导航一处搜。只负责呈现与键盘；条目由调用方给。 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../icons/Icon";
import { Kbd } from "./Button";
import { Portal } from "./Overlay";

export interface PaletteItem {
  id: string;
  group: string;
  icon: IconName;
  title: string;
  /** 右侧说明；mono=true 时按等宽显示（等效 voloctl 命令）。 */
  sub?: string;
  mono?: boolean;
  /** 额外参与匹配的文字（地址、别名…）。 */
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function CommandPalette({ items, onClose, placeholder = "搜索对象、页面或命令" }: { items: PaletteItem[]; onClose: () => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((it) => `${it.title} ${it.sub ?? ""} ${it.keywords ?? ""}`.toLowerCase().includes(s));
  }, [items, q]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const exec = (it: PaletteItem | undefined) => {
    if (!it || it.disabled) return;
    onClose();
    it.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      exec(filtered[sel]);
    }
  };

  const term = q.trim();
  return (
    <Portal>
      <div className="ry-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="ry-palette" role="dialog" aria-label="命令面板" onKeyDown={onKey}>
          <div className="ry-palette__input">
            <Icon name="search" />
            <input autoFocus type="text" value={q} onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }} placeholder={placeholder} aria-label={placeholder} />
            <Kbd>Esc</Kbd>
          </div>
          <div className="ry-palette__list" role="listbox" aria-label="结果" ref={listRef}>
            {filtered.length === 0 && <div className="ry-palette__empty">没有匹配“{term}”的对象或命令</div>}
            {filtered.map((it, i) => {
              const head = it.group !== filtered[i - 1]?.group ? <div className="ry-palette__group">{it.group}</div> : null;
              return (
                <div key={it.id} style={{ display: "contents" }}>
                  {head}
                  <div
                    className="ry-palette__opt"
                    role="option"
                    data-idx={i}
                    aria-selected={i === sel}
                    aria-disabled={it.disabled || undefined}
                    onMouseMove={() => setSel(i)}
                    onClick={() => exec(it)}
                  >
                    <Icon name={it.icon} />
                    <span className="t">{highlight(it.title, term)}</span>
                    <span className={it.mono ? "s ry-mono" : "s"}>{it.sub ? highlight(it.sub, term) : null}</span>
                    {i === sel && <Kbd>↵</Kbd>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="ry-palette__foot">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>选择
            </span>
            <span>
              <Kbd>↵</Kbd>执行
            </span>
            <span>
              <Kbd>Esc</Kbd>关闭
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
