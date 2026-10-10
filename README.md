# CodeDeck

複数の Claude Code セッションを、個人用・チーム用など複数のアカウントで同時に動かし、1つの画面で管理するデスクトップアプリ(macOS / Windows)。

- 本物の `claude` CLI を、アプリ内のターミナル(xterm.js + node-pty)でそのまま動かします。CLI を作り直してはいません
- プロファイルごとに `CLAUDE_CONFIG_DIR` を分けるので、ログアウト・ログインなしで複数のアカウントを同時に使えます。CodeDeck は資格情報を読みません
- プロジェクトに既定のプロファイルをピン留めすると、そのプロジェクトのセッションは自動で正しいアカウントで起動します

使い方は **[利用ガイド](docs/guide.md)**、仕様は [SPEC.md](SPEC.md)、設計の判断は [docs/decisions.md](docs/decisions.md) を参照。

## できること

|            |                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| アカウント | プロファイル(個人 / チームなど)ごとに別アカウントで同時実行、色とバッジで区別、ログイン状態の表示                                               |
| セッション | タブ、分割ペイン、別ウィンドウ、再起動後の復元(`--resume`)、外部ターミナルで開く、SSH でリモート実行                                            |
| 状態       | 作業中 / 入力待ち / 承認待ち / 完了 / エラー / 上限到達(Claude Code のフックで検出)                                                             |
| 使用量     | 5時間 / 7日の使用量の推定、しきい値の通知(1回だけ)、トレイ表示                                                                                  |
| Discord    | スマホから指示の送信と承認、完了・承認待ちの通知(自分のサーバーと Bot)                                                                          |
| 管理       | タスク、Git の差分とコミット(コミットメッセージは Claude Code に依頼)、プロンプトライブラリ(`/` コマンド)、スキル / MCP、統計、スケジュール実行 |
| 画面       | コマンドパレット、ライト / ダーク、日本語 / 英語、キーボード操作、自動更新                                                                      |

## インストール

[Releases](https://github.com/hamadareo/codedeck/releases) から入手します。

- **Windows**: `CodeDeck-<版>-win-x64.exe` を実行します。署名なしの版では SmartScreen の「Windows によって PC が保護されました」が出るので、「詳細情報」→「実行」を選びます
- **macOS**: `CodeDeck-<版>-mac-universal.dmg` を開き、CodeDeck を「アプリケーション」へドラッグします(Apple シリコン / Intel 両対応)。署名なしの版では、初回は Finder でアプリを右クリック →「開く」を選びます。「壊れているため開けません」と出る場合は、ターミナルで `xattr -cr /Applications/CodeDeck.app` を実行してから開きます

必要なもの: [Claude Code](https://code.claude.com/docs/en/setup)(`claude` が PATH にあること)。Windows では [Git for Windows](https://git-scm.com/download/win) も(Claude Code の Bash ツールに必要)。

## 主なショートカット

| 操作                            | macOS     | Windows                                                 |
| ------------------------------- | --------- | ------------------------------------------------------- |
| コマンドパレット                | ⌘K / ⇧⌘P  | Ctrl+Shift+K / Ctrl+Shift+P(ターミナル外では Ctrl+K も) |
| 新しいセッション / タブを閉じる | ⌘T / ⌘W   | Ctrl+Shift+T / Ctrl+Shift+W                             |
| 右 / 下に分割                   | ⌘D / ⇧⌘D  | Ctrl+Shift+D / Ctrl+Shift+E                             |
| ペインの最大化 / 閉じる         | ⇧⌘↵ / ⇧⌘W | Ctrl+Shift+Enter / Ctrl+Shift+X                         |
| 次 / 前のペイン                 | ⌘] / ⌘[   | Ctrl+Shift+] / Ctrl+Shift+[                             |
| 別ウィンドウで開く              | ⇧⌘O       | Ctrl+Shift+O                                            |
| 右パネル / 設定                 | ⌘B / ⌘,   | Ctrl+Shift+B / Ctrl+Shift+,(ターミナル外では Ctrl+, も) |

ターミナルの中では、これら以外のキーはすべて claude にそのまま渡ります(Windows の Ctrl+C は、選択範囲があるときだけコピー)。

## プライバシーと安全

- Claude Code の資格情報は読み書きしません。管理するのは設定フォルダのパスだけです
- 状態の検出は `--settings` で起動ごとにフックを追加します(プロファイルの設定ファイルは書き換えません)。フックが書くのはイベント名だけです
- 使用量と統計は、会話の記録のトークン数と時刻だけを読みます(本文は読みません)
- Discord の Bot トークンは OS のキーチェーンで暗号化します。外部への送信は、利用者が設定した Discord だけです。テレメトリはありません

## データの保存場所

- アプリのデータ: macOS `~/Library/Application Support/CodeDeck/`、Windows `%APPDATA%\CodeDeck\`(SQLite、設定、ログ)
- プロファイルの設定フォルダ: `~/.codedeck/profiles/<名前>`(中身は Claude Code が管理します)

## 開発

```sh
npm ci
npm run dev         # 開発モードで起動
npm test            # ユニットテスト(Vitest)
npm run build && npx playwright test   # E2E(偽の claude を使う)
REAL_CLAUDE=1 npx playwright test real-claude   # インストール済みの claude での確認(任意)
npm run pack        # 署名なしでパッケージ化(release/)
```

- CI(`.github/workflows/ci.yml`): push ごとに macOS と Windows で lint、型チェック、ユニット、E2E(開発版とパッケージ版)
- リリース(`.github/workflows/release.yml`): `v<版>` のタグを push すると、両 OS でインストーラーを作り、インストールしてから E2E を実行し、GitHub Release(下書き)に添付します
- macOS の署名と公証: リポジトリの Secrets に `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` を設定すると行います(なければ署名なし)
