# 設計判断ログ

1行に1つの判断を書く。形式: `日付 | 判断 | 理由`

- 2026-10-10 | Phase 0 のスパイクは `spike/` に素の JS(TypeScript/React/Vite なし)で作り、Phase 1 で `src/` に作り直す | 検証用の使い捨てコードで、早く両OSのCIに載せるため
- 2026-10-10 | ログイン状態の検出は `claude auth status --json` の `loggedIn` を使う | CLI の公式サブコマンドで、資格情報ファイルを読まずに済む(§3・§8)
- 2026-10-10 | `claude` の子プロセスに渡す env から `CLAUDECODE`・`CLAUDE_PID`・`CLAUDE_CODE_*`・`NO_COLOR`・`GIT_TERMINAL_PROMPT`、親から引き継いだ `CLAUDE_CONFIG_DIR` を除去する | Claude Code の中から CodeDeck を起動すると、これらが引き継がれて、子の claude が「ネストしたセッション」扱い(会話の記録が保存されない)になり、色も消えることを実測で確認したため。引き継いだ `CLAUDE_CONFIG_DIR` が残るとプロファイル取り違えになるため
- 2026-10-10 | `TERM=xterm-256color`・`COLORTERM=truecolor` を明示して起動する | xterm.js が 24bit カラーに対応しており、claude が 24bit 色で描画することを確認したため
- 2026-10-10 | electron-builder の `npmRebuild: false`。node-pty は同梱のプリビルド(N-API)を使う | node-pty 1.1.0 は win32/darwin(x64・arm64)のプリビルドを同梱している。ソースから再ビルドすると Visual Studio の C++ ツールが必要になり、Windows の開発環境と CI が重くなるため
- 2026-10-10 | node-pty は `asarUnpack` で asar の外に出す | ネイティブモジュールと ConPTY のバイナリ(OpenConsole.exe)は asar の中から実行できないため
- 2026-10-10 | `package.json` の `allowScripts` で node-pty・electron-winstaller のインストールスクリプトを許可する | npm 11 は、許可していないインストールスクリプトを実行しないため。なお Electron 44 はインストールスクリプトを持たず、初回使用時にバイナリを取得する
- 2026-10-10 | Windows のキーの扱い: Ctrl+C は選択範囲があればコピー、なければ ^C を CLI へ渡す。Ctrl+V は、クリップボードがテキストならブラケットペースト、画像なら Alt+V(`ESC v`)を送る。Shift+Enter は `ESC CR` を送る | Windows Terminal と同じ操作感にしつつ、画像の貼り付けは claude 自身にクリップボードを読ませるため(アプリはクリップボードの中身を書き換えない)。Alt+V は Claude Code の Windows での画像貼り付けキー。**実機での画像貼り付けは未確認**
- 2026-10-10 | Windows で node-pty を Node から直接使うスクリプトは、終了時に `process.exit()` を呼ぶ | ConPTY のエージェントがイベントループを残し、プロセスが終わらないことがあるため
- 2026-10-10 | Phase 1 の計画(`docs/phase1-plan.md`)は、利用者の「進めてください。判断はあなたに任せます」を承認として扱った | §11 の「計画の承認後に実装」に対応
- 2026-10-10 | SQLite は `better-sqlite3` ではなく、Electron に内蔵の `node:sqlite` を使う(§2 のスタックからの変更) | better-sqlite3 は Electron のバージョンごとにネイティブの再ビルドが必要で、この環境には C++ のビルドツールがない。`node:sqlite` は Electron 44(Node 24.21)で動作を確認した
- 2026-10-10 | ビルドは electron-vite 5 + Vite 7 + React 19 + Tailwind 4。TypeScript は 6.0 | electron-vite 5 は Vite 7 までに対応。typescript-eslint 8 は TypeScript 6.1 未満までに対応するため
- 2026-10-10 | セッションの ID は CodeDeck が UUID を発行し、`claude --session-id <uuid>` で起動する。復元時、`<configDir>/projects/*/<uuid>.jsonl` があれば `--resume <uuid>`、なければ同じ ID で `--session-id` | 会話の記録は最初のメッセージの後に作られるため、未使用のセッションを `--resume` すると失敗する。確認するのはファイルの有無だけで、中身は読まない
- 2026-10-10 | PTY は、復元したタブを初めて表示したときに起動する(遅延起動) | 再起動直後に全セッションの claude を一度に起動しないため(§4 のパフォーマンス)
- 2026-10-10 | プロファイルを削除しても、設定ディレクトリは削除しない(パスを表示する) | 中にログイン情報があり、アプリは資格情報に触れない方針(§3・§8)
- 2026-10-10 | アプリのショートカット: macOS は Cmd+キー、Windows は Ctrl+Shift+キー。Ctrl+Tab / Ctrl+Shift+Tab でタブ移動 | Windows では Ctrl+キーを CLI(Ctrl+C、Ctrl+W、Ctrl+K など)に渡すため。§3-6 の Ctrl+Shift+P とも整合する
- 2026-10-10 | 「外部ターミナルで開く」では、アプリ内の PTY を止めてから、同じ会話 ID を外部で再開する。Windows は `powershell -EncodedCommand` の中で `CLAUDE_CONFIG_DIR` を設定し、Windows Terminal があれば `wt -w new` で開く。macOS は osascript で Terminal.app / iTerm2 | 同じ会話を2か所で同時に動かさないため。wt は既存ウィンドウのプロセスの環境変数を使うことがあり、`;` を区切り文字として解釈するので、エンコードしたコマンドで確実に渡す
- 2026-10-10 | パスの表示は等幅フォント(Cascadia Mono / Consolas など)にする | 日本語の UI フォントは `\` を `¥` で描くため
