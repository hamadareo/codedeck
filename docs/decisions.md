# 設計判断ログ

1行に1つの判断を書く。形式: `日付 | 判断 | 理由`

- 2026-10-10 | Phase 0 のスパイクは `spike/` に素の JS(TypeScript/React/Vite なし)で作り、Phase 1 で `src/` に作り直す | 検証用の使い捨てコードで、早く両OSのCIに載せるため
- 2026-10-10 | ログイン状態の検出は `claude auth status --json` の `loggedIn` を使う | CLI の公式サブコマンドで、資格情報ファイルを読まずに済む(§3・§8)
- 2026-10-10 | `claude` の子プロセスに渡す env から `CLAUDECODE`・`CLAUDE_PID`・`CLAUDE_CODE_*`・`NO_COLOR`・`GIT_TERMINAL_PROMPT` を除去する | Claude Code の中から CodeDeck を起動すると、これらが引き継がれて、子の claude が「ネストしたセッション」扱い(会話の記録が保存されない)になり、色も消えることを実測で確認したため
- 2026-10-10 | `TERM=xterm-256color`・`COLORTERM=truecolor` を明示して起動する | xterm.js が 24bit カラーに対応しており、claude が 24bit 色で描画することを確認したため
- 2026-10-10 | electron-builder の `npmRebuild: false`。node-pty は同梱のプリビルド(N-API)を使う | node-pty 1.1.0 は win32/darwin(x64・arm64)のプリビルドを同梱している。ソースから再ビルドすると Visual Studio の C++ ツールが必要になり、Windows の開発環境と CI が重くなるため
- 2026-10-10 | node-pty は `asarUnpack` で asar の外に出す | ネイティブモジュールと ConPTY のバイナリ(OpenConsole.exe)は asar の中から実行できないため
- 2026-10-10 | `package.json` の `allowScripts` で electron・node-pty・electron-winstaller のインストールスクリプトを許可する | npm 11 は、許可していないインストールスクリプトを実行しないため
- 2026-10-10 | Windows のキーの扱い: Ctrl+C は選択範囲があればコピー、なければ ^C を CLI へ渡す。Ctrl+V は、クリップボードがテキストならブラケットペースト、画像なら ^V をそのまま渡す。Shift+Enter は `ESC CR` を送る | Windows Terminal と同じ操作感にしつつ、画像の貼り付けは claude 自身にクリップボードを読ませるため(アプリは中身を書き換えない)
- 2026-10-10 | Windows で node-pty を Node から直接使うスクリプトは、終了時に `process.exit()` を呼ぶ | ConPTY のエージェントがイベントループを残し、プロセスが終わらないことがあるため
