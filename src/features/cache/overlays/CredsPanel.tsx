// Volo · Cache —— 凭据管理（B6）。移植自新原型 page_cache.jsx 的 CredsPanel。
// 凭据仅用于共享 DDC 创建/接入；其余远程操作走 SSH key，不再逐操作选凭据。
// 真命令：listCredentials / saveCredential / deleteCredential（SecretStore，AES-GCM）。删除走二次确认。
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/Button";
import { useCache } from "../state/store";
import { useAsync } from "../state/useAsync";
import { listCredentials, saveCredential, deleteCredential } from "../api/commands";
import type { CredentialKind, CredentialRecord } from "../api/types";

const KINDS: { id: CredentialKind; label: string }[] = [
  { id: "share", label: "共享访问" },
  { id: "winrm", label: "WinRM" },
];

export function CredsPanel() {
  const { setDrawer, runTask } = useCache();
  const credsQ = useAsync<CredentialRecord[]>(() => listCredentials(), []);
  const creds = credsQ.data ?? [];
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ alias: string; kind: CredentialKind; username: string; password: string }>(
    { alias: "", kind: "share", username: "", password: "" },
  );
  const close = () => setDrawer(null);

  const addCred = () => {
    const alias = form.alias.trim();
    if (!alias) return;
    const { kind, username, password } = form;
    runTask({
      domain: "cred",
      action: "save",
      target: alias,
      chan: "ssh",
      note: "写入 SecretStore（AES-GCM）",
      lines: [
        { msg: "save_credential " + alias },
        { lv: "ok", msg: alias + " 已写入 SecretStore" },
      ],
      run: async () => {
        await saveCredential(alias, kind, username, password);
        credsQ.reload();
      },
    });
    setForm({ alias: "", kind: "share", username: "", password: "" });
    setAdding(false);
  };

  const delCred = (c: CredentialRecord) => {
    setConfirmDel(null);
    runTask({
      domain: "cred",
      action: "delete",
      target: c.alias,
      chan: "ssh",
      note: "从 SecretStore 删除",
      lines: [
        { lv: "warn", msg: "delete_credential " + c.alias },
        { lv: "ok", msg: c.alias + " 已删除" },
      ],
      run: async () => {
        await deleteCredential(c.alias);
        credsQ.reload();
      },
    });
  };

  return (
    <div className="drawer drawer--creds">
      <div className="drawer-h">
        <span className="di info">
          <Icon name="key" size={17} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h2>凭据管理</h2>
          <div className="sub">
            <span className="cli-pill">list / save / delete_credential</span>
            <span> · SecretStore</span>
          </div>
        </div>
        <button className="iconbtn x" onClick={close}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="drawer-b">
        <div className="creds-note">
          <Icon name="shield" size={13} />
          凭据仅用于共享 DDC 的创建 / 接入；其余远程操作走 SSH key，不再逐操作选凭据。
        </div>
        <div className="creds-list">
          {creds.length === 0 ? (
            <div className="creds-empty">
              <Icon name="key" size={22} />
              <span>{credsQ.error === "not-in-tauri" ? "需在 Volo 桌面应用内读取凭据" : "还没有凭据，点下方新增"}</span>
            </div>
          ) : (
            creds.map((c) => (
              <div key={c.alias} className={"cred-row" + (confirmDel === c.alias ? " danger" : "")}>
                <span className="cred-ico">
                  <Icon name="key" size={15} />
                </span>
                <div className="cred-meta">
                  <div className="cred-name mono">{c.alias}</div>
                  <div className="cred-sub">
                    {c.kind} · {c.username || "—"}
                  </div>
                </div>
                {confirmDel === c.alias ? (
                  <div className="cred-confirm">
                    <span className="cc-q">删除？</span>
                    <button className="mini-btn" onClick={() => setConfirmDel(null)}>
                      取消
                    </button>
                    <button className="mini-btn danger" onClick={() => delCred(c)}>
                      <Icon name="trash" size={12} />
                      确认删除
                    </button>
                  </div>
                ) : (
                  <button
                    className="iconbtn cred-del"
                    title="删除凭据"
                    onClick={() => setConfirmDel(c.alias)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
      <div className="drawer-f">
        {adding ? (
          <div className="cred-add">
            <div className="cred-add-kinds">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  className={"cred-kind" + (form.kind === k.id ? " on" : "")}
                  onClick={() => setForm((f) => ({ ...f, kind: k.id }))}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <input
              className="dp-input mono"
              placeholder="凭据名 / alias（如 zen-svc）"
              value={form.alias}
              autoFocus
              spellCheck={false}
              onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))}
            />
            <input
              className="dp-input mono"
              placeholder="用户名"
              value={form.username}
              spellCheck={false}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
            <input
              className="dp-input mono"
              type="password"
              placeholder="密码（写入 SecretStore，不回显）"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
            <div className="cred-add-acts">
              <Button
                variant="secondary"
                size="M"
                onPress={() => {
                  setAdding(false);
                  setForm({ alias: "", kind: "share", username: "", password: "" });
                }}
              >
                取消
              </Button>
              <Button
                variant="accent"
                size="M"
                isDisabled={!form.alias.trim()}
                icon={<Icon name="check" size={14} />}
                onPress={addCred}
              >
                保存凭据
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="accent" size="M" icon={<Icon name="plus" size={15} />} onPress={() => setAdding(true)}>
            新增凭据
          </Button>
        )}
      </div>
    </div>
  );
}
