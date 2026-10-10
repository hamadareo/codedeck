# Phase 0 検証レポート

- 実施日: 2026-10-10
- 実機: **Windows 11 Home(x64)のみ**。**Mac の実機はない**ため、Mac は CI(GitHub Actions `macos-latest`)で確認できる範囲だけを報告する(§9 の Phase 0 完了条件にもとづく)。
- バージョン: Claude Code 2.1.295 / Node.js 24.20.0 / Electron 44.7.0 / node-pty 1.1.0 / @xterm/xterm 6.0.0
- 成果物: `spike/`(Electron スパイク、自動プローブ、CI 用スモークテスト)、`.github/workflows/ci.yml`

## 結論(続行可否)

**条件付きで続行可。** Windows では、`CLAUDE_CONFIG_DIR` によるプロファイル分離と、埋め込みターミナルでの claude の動作を、自動テストの範囲で確認できた。ただし次の2点が未確認で、Phase 1 の完了判定までに必ず確認する。

1. **2つの別アカウントで同時にログインし、混ざらないこと**(§3-8 の (a)(b))。2つ目のアカウントでの実際のログインが必要で、利用者の操作が要る。手順は下記。
2. **Mac の資格情報の分離**(キーチェーン)。Mac の実機がないため確認できていない。**ここが分離できない場合は、§3-8 のとおり設計を止めて再検討する。**

## 1. プロファイル分離(§3-8)

| 項目 | Windows | Mac |
|---|---|---|
| `CLAUDE_CONFIG_DIR` を変えると、別の設定ディレクトリが使われる | ✅ `claude auth status --json` の `configDirectory` が切り替わる | ⏳ 実機なし |
| 新しいディレクトリは、既定のログインを引き継がない | ✅ 既定(`~/.claude`)はログイン済みで、`~/.codedeck/profiles/spike-personal` と `spike-team` はどちらも `loggedIn:false`。claude を起動すると初回セットアップ(テーマ選択→ログイン)になる | ⏳ |
| 資格情報の保存場所 | 設定ディレクトリの中(`~/.claude/.credentials.json` が存在する。ファイル名だけ確認し、中身は読んでいない) | ⏳ キーチェーンと言われている。設定ディレクトリごとに別項目になるかが論点 |
| (a) 2つの別アカウントでログインできる | ⏳ 利用者の操作待ち | ⏳ |
| (b) 同時に起動しても混ざらない | ⏳ 利用者の操作待ち | ⏳ |

**分かったこと:** ログイン状態は `claude auth status --json` で取れる(`loggedIn`、`email`、`subscriptionType`、`configDirectory` など)。資格情報のファイルを読まずに「接続済み」を判定できるので、§3-2 の「ログイン完了を検出」はこれを使う。

### (a)(b) の確認手順(利用者が行う)
```powershell
# 1つ目のプロファイル(例: 個人アカウント)
$env:CLAUDE_CONFIG_DIR="$HOME\.codedeck\profiles\spike-personal"; claude   # /login でログイン
# 2つ目のプロファイル(例: チームアカウント)。別のウィンドウで
$env:CLAUDE_CONFIG_DIR="$HOME\.codedeck\profiles\spike-team"; claude       # /login でログイン
# 確認: 2つの email / orgName が別々で、既定の ~/.claude も変わっていないこと
foreach ($n in 'spike-personal','spike-team') { $env:CLAUDE_CONFIG_DIR="$HOME\.codedeck\profiles\$n"; claude auth status --text }
Remove-Item Env:CLAUDE_CONFIG_DIR; claude auth status --text
```
または `cd spike; npm start` で、「+ 個人」「+ チーム」を並べて開き、それぞれで `/login` し、両方で `/status` を確認する。

## 2. 埋め込みターミナル(xterm.js + node-pty)

### 自動で確認した項目(`spike/pty-probe.mjs`、Windows・ConPTY)
本物の claude を PTY で起動し、`@xterm/headless` で画面を再現して確認した。プロンプトは送信していない(使用量を消費しない)。

| 項目 | 結果 |
|---|---|
| claude の対話モードが起動し、正しく描画される | ✅ |
| 信頼確認ダイアログ(CLI の画面)がそのまま表示・操作できる | ✅ |
| 日本語の入力と表示(全角の幅) | ✅ 「こんにちは世界」が崩れずに表示された |
| 絵文字の表示 | ✅ 「🎉」 |
| `Shift+Enter`(`ESC CR`)で入力欄に改行が入る | ✅ |
| `Shift+Tab` で権限モードが切り替わる | ✅ auto → manual → accept edits |
| `Ctrl+U` で入力を消す | ✅ |
| `/` でスラッシュコマンドの一覧が出て、`/resum` で `/resume` に絞り込まれる | ✅ |
| `Esc` でメニューが閉じる | ✅ |
| リサイズ(100×30 → 70×20 → 120×35)に追従して描き直す | ✅ |
| 24bit カラー | ✅(env を整理したあと。下記) |
| Electron アプリ内での表示(xterm.js の DOM に claude の画面が描画される) | ✅ 開発版と、パッケージ版(`release/win-unpacked/CodeDeckSpike.exe`)の両方 |

### 人の手で確認が必要な項目(スパイクで `npm start` して確認)
自動化できないため、まだ確認していない。

- 日本語 IME での変換・確定(上の自動テストは確定後の文字列を送っただけ)
- 画像の貼り付け(Windows で `Ctrl+V` / `Alt+V`)、ファイルのドラッグ&ドロップ
- マウス操作、スクロールバック、リンクのクリック、選択とコピー
- `/resume` で実際に会話を再開する、`/compact`、`!` でのシェル実行、`@` でのファイル指定
- スキル、プラグイン、MCP、フック、サブエージェント、CLAUDE.md、settings.json(プロファイルごとの設定ディレクトリで動くか)
- 通常のターミナル(Windows Terminal)で直接 `claude` を使ったときとの見た目の比較

## 3. 見つかった問題と対応

| # | 問題 | 対応 |
|---|---|---|
| 1 | **Claude Code の中から CodeDeck を起動すると、`CLAUDECODE`・`CLAUDE_CODE_*` が子に引き継がれ**、子の claude が「Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker」になり、会話が保存されなかった(`/resume` が使えなくなる) | 起動前に env から除去する(`spike/platform.js` の `sanitizeEnv`)。Phase 1 にも引き継ぐ |
| 2 | 親の `NO_COLOR=1` が引き継がれ、色が消えた | 同じく除去し、`COLORTERM=truecolor` を設定 |
| 3 | 信頼確認はプロファイル(設定ディレクトリ)ごとに出る | 仕様どおりの CLI の動作。アプリは何もしない。オンボーディングで「初回は信頼確認が出る」と案内する |
| 4 | electron-builder が node-pty をソースから再ビルドしようとして、Visual Studio の C++ ツールがなく失敗 | `npmRebuild: false` にし、同梱のプリビルドを使う |
| 5 | npm 11 が electron・node-pty のインストールスクリプトを実行しない | `allowScripts` で許可。ローカルでは electron の `install.js` を手動で実行した |
| 6 | Windows で node-pty の子プロセスが終わっても、Node のプロセスが終わらないことがある | スクリプトの最後で `process.exit()` を呼ぶ。Electron 本体では、ウィンドウを閉じたときに PTY を kill する |
| 7 | 開発機に Node.js と Git がなかった | Git for Windows は winget で導入。Node.js は MSI が「別のインストールが進行中」(1618)で失敗したため、公式の zip を SHA256 で検証して `%LOCALAPPDATA%\Programs\nodejs` に置いた |

## 4. CI(GitHub Actions)

`.github/workflows/ci.yml`: `macos-latest` と `windows-latest` のマトリクスで、`npm ci` → node-pty のスモークテスト(env の受け渡し、スペースと日本語を含むパス、リサイズ)→ `electron-builder --dir` → node-pty が asar の外に出ていることの確認。

- 結果(2026-10-10 追記): リポジトリ `hamadareo/codedeck`(Private)に push し、CI #9 で **macOS・Windows とも成功**(lint、型チェック、ユニット 110 件、開発版とパッケージ版の E2E)。途中で見つかって直した問題は [ci-report.md](ci-report.md) を参照

**Mac について CI で分かるのは**: 依存関係のインストール、node-pty(darwin のプリビルド)の読み込みと PTY の起動、パッケージ化まで。**claude の起動、ログイン、キーチェーンの分離は CI では確認できない**(CI に claude のアカウントがないため)。

## 5. Phase 1 に持ち越すこと

- 上記の (a)(b) の確認(Windows)と、Mac 実機での確認一式。
- 外部ターミナルで開く(§2.6-5): Windows Terminal の `wt.exe` は、すでにウィンドウがあると、その既存プロセスの環境変数を使うことがある。`CLAUDE_CONFIG_DIR` が確実に渡るよう、`powershell -NoExit -Command` で変数を設定してから claude を起動する方式を基本にし、Phase 1 で実機で確認する。
