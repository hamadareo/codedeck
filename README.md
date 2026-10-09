# CodeDeck

複数の Claude Code セッションを、個人用・チーム用など複数のアカウントで同時に動かし、1つの画面で管理するデスクトップアプリ(macOS / Windows)。仕様は [SPEC.md](SPEC.md)、進み具合は [docs/](docs/) を参照。

- 本物の `claude` CLI を、アプリ内のターミナル(xterm.js + node-pty)でそのまま動かします。CLI を作り直してはいません。
- プロファイルごとに `CLAUDE_CONFIG_DIR` を分けるので、ログアウト・ログインなしで複数のアカウントを同時に使えます。CodeDeck は資格情報を読みません。
- プロジェクトに既定のプロファイルをピン留めすると、そのプロジェクトのセッションは自動で正しいアカウントで起動します。

## 必要なもの

- [Claude Code](https://code.claude.com/docs/en/setup)(`claude` が PATH にあること)
- Windows: [Git for Windows](https://git-scm.com/download/win)(Claude Code の Bash ツールに必要)
- 開発: Node.js 24

## 開発

```sh
npm ci
npm run dev         # 開発モードで起動
npm test            # ユニットテスト(Vitest)
npm run build && npx playwright test   # E2E(偽の claude を使う)
REAL_CLAUDE=1 npx playwright test real-claude   # インストール済みの claude での確認(任意)
npm run pack        # 署名なしでパッケージ化(release/)
```

## 署名なしのビルドを実行するとき

- **Windows**: SmartScreen の「Windows によって PC が保護されました」が出たら、「詳細情報」→「実行」を選びます。
- **macOS**: 初回は Finder でアプリを右クリック →「開く」を選びます。

## データの保存場所

- アプリのデータ: Electron の `userData`(macOS: `~/Library/Application Support/CodeDeck/`、Windows: `%APPDATA%\CodeDeck\`)
- プロファイルの設定ディレクトリ: `~/.codedeck/profiles/<名前>`(中身は Claude Code が管理します)
