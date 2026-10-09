# Phase 0 spike

本物の `claude` を xterm.js + node-pty で動かし、プロファイルごとに `CLAUDE_CONFIG_DIR` を分けて起動する検証用のアプリ。Phase 1 で `src/` に作り直す。

```sh
npm ci
npm start                 # アプリを起動。「+ 個人」「+ チーム」「+ 既定」でペインを開く
npm run smoke             # node-pty のスモークテスト(claude 不要、CI でも実行)
npm run probe -- default  # claude を PTY で起動し、キー操作ごとの画面を probe-output/ に保存
npm run pack              # electron-builder --dir
```

プロファイルの設定ディレクトリ: `~/.codedeck/profiles/<name>`
