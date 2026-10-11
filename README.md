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
| ファイル   | 右パネルでフォルダをツリー表示・プレビュー、`@パス` で claude に渡す(ボタン / ドラッグ&ドロップ)、ターミナル内の検索                            |
| 管理       | タスク、Git の差分とコミット(コミットメッセージは Claude Code に依頼)、プロンプトライブラリ(`/` コマンド)、スキル / MCP、統計、スケジュール実行 |
| 画面       | コマンドパレット、ライト / ダーク、日本語 / 英語、キーボード操作、自動更新                                                                      |

## インストール

[Releases](https://github.com/hamadareo/codedeck/releases) から入手します。

- **Windows**: `CodeDeck-<版>-win-x64.exe` を実行します。署名なしの版では SmartScreen の「Windows によって PC が保護されました」が出るので、「詳細情報」→「実行」を選びます
- **macOS**: `CodeDeck-<版>-mac-universal.dmg` を開き、CodeDeck を「アプリケーション」へドラッグします(Apple シリコン / Intel 両対応)。署名なしの版では警告が出て開けないので、次のどちらかで開きます
  - 「開発元を検証できません」「Apple は検証できませんでした」: 警告を閉じ、**システム設定 → プライバシーとセキュリティ** の下の方にある「このまま開く」を押します(macOS 15 以降は Finder の右クリック →「開く」では開けません)
  - 「壊れているため開けません」: ターミナルで次を実行してから開きます
    ```
    xattr -cr /Applications/CodeDeck.app
    codesign --force --deep -s - /Applications/CodeDeck.app
    ```

必要なもの: [Claude Code](https://code.claude.com/docs/en/setup)(`claude` が PATH にあること)。Windows では [Git for Windows](https://git-scm.com/download/win) も(Claude Code の Bash ツールに必要)。

## 純正ターミナルの claude との共存

いつものターミナルで使っている claude(例: チームプランでログイン済み)と、CodeDeck に追加したアカウント(チーム・個人など)は、互いに邪魔をしません。

- **保存場所が別**: ターミナルの claude は `~/.claude` を使い、CodeDeck のプロファイルはそれぞれ専用のフォルダ(`~/.codedeck/profiles/<名前>`)を `CLAUDE_CONFIG_DIR` で指定して使います。ログイン情報も設定も別に保存されるので、CodeDeck でログインしても、ターミナル側のログインは上書きされず、ログインし直しを求められることもありません
- **`~/.claude` を書き換えない**: CodeDeck は `~/.claude` を読み書きしません。状態の検出に使うフックも、CodeDeck が起動する claude に起動時の引数(`--settings`)で渡すだけで、設定ファイルには書き込みません
- **同じアカウントを両方で使える**: ターミナルと CodeDeck の両方に同じアカウントでログインしても、別々のログインとして並んで使えます。使用量の上限はアカウント単位なので、両方の分が合算されます

別々であるために、次の点に注意してください(不具合ではありません)。

- ターミナル側の `~/.claude` に置いた設定(全体の `CLAUDE.md`、`settings.json` の許可設定、MCP サーバー、プラグイン、自作のスラッシュコマンド)は、CodeDeck のセッションには効きません。必要なら各プロファイルにも入れます。プロジェクトのフォルダ内の `.claude/` と `CLAUDE.md` は共通です
- 会話の履歴も別々です。ターミナルの `claude --resume` には、CodeDeck で行った会話は出てきません(逆も同じ)
- ターミナルと CodeDeck で同じフォルダを同時に作業させると、同じファイルを両方が書き換えて衝突することがあります(claude を2つ同時に動かす場合と同じです)

> macOS ではログイン情報がキーチェーンに保存されます。設定フォルダが違えば別の項目として保存される想定ですが、まだ Mac の実機で確認していません。CodeDeck でログインしたあと、ターミナルで `claude` を起動してログインし直しを求められないか確かめ、求められた場合は Issue で知らせてください。

## 主なショートカット

| 操作                            | macOS     | Windows                                                 |
| ------------------------------- | --------- | ------------------------------------------------------- |
| コマンドパレット                | ⌘K / ⇧⌘P  | Ctrl+Shift+K / Ctrl+Shift+P(ターミナル外では Ctrl+K も) |
| 新しいセッション / タブを閉じる | ⌘T / ⌘W   | Ctrl+Shift+T / Ctrl+Shift+W                             |
| 右 / 下に分割                   | ⌘D / ⇧⌘D  | Ctrl+Shift+D / Ctrl+Shift+E                             |
| ペインの最大化 / 閉じる         | ⇧⌘↵ / ⇧⌘W | Ctrl+Shift+Enter / Ctrl+Shift+X                         |
| 次 / 前のペイン                 | ⌘] / ⌘[   | Ctrl+Shift+] / Ctrl+Shift+[                             |
| 別ウィンドウで開く              | ⇧⌘O       | Ctrl+Shift+O                                            |
| ターミナル内を検索              | ⌘F        | Ctrl+Shift+F                                            |
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
