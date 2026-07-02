//! Volo 专用 SSH 传输密钥。靠 shell out `ssh-keygen` 生成 ed25519 keypair
//! （ssh-keygen 与系统 ssh 一起安装，Mac/Windows 都有），不引入 crypto crate。
//! 私钥 / 公钥 / known_hosts 都落在应用配置目录（见 `startup::resolve_config_dir`）。

use crate::error::{VoloError, VoloResult};
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct KeyStore {
    dir: PathBuf,
}

impl KeyStore {
    /// 用显式目录构造（生产传 `startup::resolve_config_dir()?`，测试传 tempdir）。
    pub fn at(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    pub fn private_key_path(&self) -> PathBuf {
        self.dir.join("uecm_ed25519")
    }

    pub fn public_key_path(&self) -> PathBuf {
        self.dir.join("uecm_ed25519.pub")
    }

    pub fn known_hosts_path(&self) -> PathBuf {
        self.dir.join("known_hosts")
    }

    /// 确保 keypair 就绪后可读。已有完整一对则 no-op；私钥在而公钥缺失/损坏
    /// （上次 ssh-keygen 写完私钥后中断、或 .pub 被删）时，从私钥重导出公钥，
    /// 而不是误判“已存在”导致后续 `public_key()` 失败；都缺则全新生成。
    /// 可在每次启动时无脑调用。
    pub fn ensure_keypair(&self) -> VoloResult<()> {
        // 并发防护：读路径命令 async 化（spawn_blocking）后，首启挂载期的远程读会并发
        // 走到这里；check-then-generate 不加锁时并发 ssh-keygen 撞同一路径——后到者
        // 碰到已存在的私钥会停在 Overwrite 交互提示、stdin EOF 退出非零，首次运行报
        // 一堆假错。进程级锁串行化整个检查→生成，后到者拿锁后走 exists() 早返回。
        static GEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _gen = GEN_LOCK.lock().unwrap();
        let key = self.private_key_path();
        let pubkey = self.public_key_path();
        if key.exists() && pubkey.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;

        // 私钥在、公钥缺：从私钥导出公钥（-y 走 stdout），不重建私钥。
        if key.exists() {
            let out = Command::new("ssh-keygen")
                .arg("-y")
                .arg("-f")
                .arg(&key)
                .output()
                .map_err(|e| {
                    VoloError::Configuration(format!("spawn ssh-keygen -y failed: {e}"))
                })?;
            if !out.status.success() {
                return Err(VoloError::Configuration(format!(
                    "ssh-keygen -y failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                )));
            }
            std::fs::write(&pubkey, &out.stdout)?;
            return Ok(());
        }

        // 都缺（或只剩残留 .pub）：清掉半成品后全新生成一对。
        let _ = std::fs::remove_file(&pubkey);
        let out = Command::new("ssh-keygen")
            .arg("-t")
            .arg("ed25519")
            .arg("-f")
            .arg(&key)
            .arg("-N")
            .arg("") // 空 passphrase
            .arg("-C")
            .arg("volo")
            .arg("-q")
            .output()
            .map_err(|e| VoloError::Configuration(format!("spawn ssh-keygen failed: {e}")))?;
        if !out.status.success() {
            return Err(VoloError::Configuration(format!(
                "ssh-keygen failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        Ok(())
    }

    /// 读取并返回公钥串（含算法前缀，如 `ssh-ed25519 AAAA... volo`），
    /// 供 bootstrap 包 / UI 复制到节点 `administrators_authorized_keys`。
    pub fn public_key(&self) -> VoloResult<String> {
        let s = std::fs::read_to_string(self.public_key_path())?;
        Ok(s.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ensure_keypair_generates_then_is_idempotent() {
        let dir = tempdir().unwrap();
        let ks = KeyStore::at(dir.path());
        assert!(!ks.private_key_path().exists());

        ks.ensure_keypair().unwrap();
        assert!(ks.private_key_path().exists());
        assert!(ks.public_key_path().exists());

        let pub1 = ks.public_key().unwrap();
        // 第二次调用不重生成（公钥不变）。
        ks.ensure_keypair().unwrap();
        assert_eq!(pub1, ks.public_key().unwrap());
        assert!(pub1.starts_with("ssh-ed25519 "));
    }

    #[test]
    fn ensure_keypair_regenerates_missing_pub() {
        let dir = tempdir().unwrap();
        let ks = KeyStore::at(dir.path());
        ks.ensure_keypair().unwrap();
        // 模拟中断/损坏：私钥还在，公钥被删。
        std::fs::remove_file(ks.public_key_path()).unwrap();
        assert!(!ks.public_key_path().exists());
        ks.ensure_keypair().unwrap();
        assert!(ks.public_key_path().exists());
        assert!(ks.public_key().unwrap().starts_with("ssh-ed25519 "));
    }
}
