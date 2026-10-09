# Phase 1 実装計画(MVP)

利用者の指示(2026-10-10「進めてください。判断はあなたに任せます」)を、この計画の承認として扱う。

## 範囲
- Electron + TypeScript + React + Vite(electron-vite)+ Tailwind の雛形
- プロファイル: 追加 / 削除 / 一覧、ログイン状態の検出(`claude auth status --json`)
- プロジェクト: 登録、既定プロファイルのピン留め
- セッション: プロファイルを指定して起動、タブ表示、プロファイルの色とバッジ、ピンと違うときの確認ダイアログ
- セッションの保存と復元(`--session-id <uuid>` で起動し、`--resume <uuid>` で再開)
- 外部ターミナルで開く(Windows Terminal / PowerShell、Terminal.app / iTerm2)
- i18n の土台(ja 既定、en)。状態検出、分割ペイン、コマンドパレットなどは Phase 2

## ファイル構成
```
src/
  shared/        型、IPC の契約、純粋なロジック(キーの扱い、プロファイルの規則、i18n)
  main/
    index.ts     アプリの起動、ウィンドウ
    ipc.ts       IPC ハンドラの登録(main が状態を唯一持つ)
    db/          node:sqlite、マイグレーション(PRAGMA user_version)
    profiles/    リポジトリ、ログイン状態の確認
    projects/    リポジトリ
    sessions/    リポジトリ、PTY 管理、会話の記録の有無の確認
    platform/    env の整理、claude の解決と起動の組み立て、外部ターミナル、パス
  preload/       contextBridge で window.codedeck を公開
  renderer/      React の UI(ui/ にコンポーネント、terminal/ に xterm の管理)
tests/unit/      Vitest
e2e/             Playwright(偽の claude で、主要フローを検証)
```

## データモデル(SQLite: `userData/codedeck.db`)
| テーブル | 列 |
|---|---|
| profiles | id, name(一意), kind(personal/team/other), color, icon, config_dir, note, auth_status(unknown/connected/logged_out), account_email, sort, created_at |
| projects | id, name, path, pinned_profile_id(→profiles, 削除時 NULL), created_at |
| sessions | id(= claude のセッション UUID), title, project_id, profile_id, cwd, open(タブとして開いているか), location(embedded/external), started(一度でも起動したか), created_at, last_active_at |

- 資格情報は持たない。`account_email` は `claude auth status` が返す表示用の情報だけ。
- プロファイルを削除しても、設定ディレクトリは消さない(中に資格情報があるため、アプリは触れない)。パスを表示し、消すかどうかは利用者に任せる。

## IPC
- invoke: `env:info`、`profiles:list|create|update|remove|checkAuth`、`projects:list|create|update|remove`、`dialog:pickFolder`、`sessions:list|create|close|openExternal|reopenEmbedded`、`pty:start`、`clipboard:read`
- send: `pty:input`、`pty:resize`、`clipboard:write`、`link:open`
- main → renderer: `pty:data`、`pty:exit`、`state:changed`(一覧が変わったので取り直す)

## テスト
- ユニット: env の整理、起動引数(新規 / 再開)、キーの扱い、プロファイルの規則、外部ターミナルのコマンド(クォート)、DB の CRUD、復元の判断
- E2E: 偽の claude(受け取った `CLAUDE_CONFIG_DIR` と引数を表示する)で、2つのプロファイル → 2つのタブが別の設定ディレクトリで同時に動く → 再起動すると `--resume` で復元される、までを両OSの CI で確認する
