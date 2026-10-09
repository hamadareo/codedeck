/** Minimal i18n (§4: Japanese default, English available). */
const ja = {
  'app.name': 'CodeDeck',
  'common.cancel': 'キャンセル',
  'common.add': '追加',
  'common.create': '作成',
  'common.remove': '削除',
  'common.close': '閉じる',
  'common.none': 'なし',
  'common.browse': 'フォルダを選択…',

  'kind.personal': '個人',
  'kind.team': 'チーム',
  'kind.other': 'その他',

  'auth.connected': '接続済み',
  'auth.logged_out': '未ログイン',
  'auth.unknown': '確認中',
  'auth.check': 'ログイン状態を確認',

  'sidebar.profiles': 'プロファイル',
  'sidebar.projects': 'プロジェクト',
  'sidebar.addProfile': 'プロファイルを追加',
  'sidebar.addProject': 'プロジェクトを追加',
  'sidebar.newSessionIn': 'このプロジェクトで新しいセッション',
  'sidebar.pinned': '既定のプロファイル',
  'sidebar.history': '閉じたセッション',
  'sidebar.reopen': '開き直す',
  'sidebar.otherSessions': 'プロジェクト外のセッション',
  'sidebar.noProjects': 'プロジェクトはまだありません',

  'profile.dialog.title': 'プロファイルを追加',
  'profile.name': '名前',
  'profile.namePlaceholder': '例: 個人, 会社チーム',
  'profile.kind': '種別',
  'profile.color': '色',
  'profile.configDir': '設定ディレクトリ',
  'profile.configDirHint':
    'このプロファイル専用のフォルダです。ログイン情報は Claude Code が管理し、CodeDeck は中身を読みません。',
  'profile.afterCreate':
    '作成すると、このプロファイルで claude が起動します。画面の案内に従って /login してください。',
  'profile.error.nameRequired': '名前を入力してください',
  'profile.error.nameTooLong': '名前が長すぎます(40文字まで)',
  'profile.error.nameInvalid': '名前に使えない文字が含まれています(\\ / : * ? " < > | など)',
  'profile.error.nameTaken': '同じ名前のプロファイルがあります',
  'profile.remove.title': 'プロファイル「{name}」を削除しますか?',
  'profile.remove.body':
    'CodeDeck の一覧から削除し、このプロファイルのセッションを閉じます。設定ディレクトリ(ログイン情報を含む)は削除しません:\n{dir}',
  'profile.removed': '削除しました。設定ディレクトリは残っています: {dir}',

  'project.dialog.title': 'プロジェクトを追加',
  'project.folder': 'フォルダ',
  'project.name': '表示名',
  'project.pin': '既定のプロファイル(ピン留め)',
  'project.pinHint': 'このプロジェクトのセッションは、自動でこのプロファイルで起動します。',
  'project.remove.title': 'プロジェクト「{name}」を一覧から削除しますか?',
  'project.remove.body': 'フォルダとセッションの記録は削除しません。',

  'session.dialog.title': '新しいセッション',
  'session.project': 'プロジェクト',
  'session.noProject': 'プロジェクトなし(フォルダを指定)',
  'session.profile': 'プロファイル',
  'session.cwd': '作業ディレクトリ',
  'session.pinnedDefault': '(ピン留め)',
  'session.start': '開始',
  'session.mismatch.title': 'ピン留めと違うプロファイルで開始しますか?',
  'session.mismatch.body':
    'プロジェクト「{project}」の既定は「{pinned}」です。「{chosen}」で開始すると、別のアカウントで作業することになります。',
  'session.mismatch.confirm': '「{chosen}」で開始する',
  'session.state.idle': '未起動',
  'session.state.running': '実行中',
  'session.state.exited': '終了',
  'session.state.external': '外部ターミナル',
  'session.openExternal': '外部ターミナルで開く',
  'session.openExternal.title': '外部ターミナルで開きますか?',
  'session.openExternal.body':
    'アプリ内のターミナルを閉じ、OS のターミナルで同じ会話を再開します。外部ターミナルでは、Discord からの入力はできず、状態の検出もできません(フックを設定した場合を除く)。',
  'session.external.banner': 'このセッションは外部ターミナルで実行中です',
  'session.external.limits':
    'Discord からの入力と状態の検出は使えません。外部ターミナルで claude を終了してから、アプリに戻してください。',
  'session.reclaim': 'アプリに戻す',
  'session.exited': 'claude が終了しました(コード {code})',
  'session.restart': '再開する',
  'session.close': 'タブを閉じる',
  'session.remove': '記録から削除',
  'session.new': '新しいセッション',
  'session.startFailed': '起動できませんでした: {msg}',

  'empty.welcome': 'CodeDeck へようこそ',
  'empty.step1': 'プロファイル(個人用・チーム用など)を追加する',
  'empty.step2': 'プロジェクトのフォルダを追加し、既定のプロファイルをピン留めする',
  'empty.step3': 'セッションを開始する。以後、アカウントの切り替えは不要です',
  'empty.noSession': '開いているセッションはありません',

  'claude.notFound':
    'claude コマンドが見つかりません。Claude Code をインストールして PATH を通してください。',
  'claude.installGuide': 'インストール手順を開く',
  'git.missing': 'Git for Windows が見つかりません。Claude Code の Bash ツールに必要です。',
  'git.installGuide': 'Git for Windows を入手',

  'shortcut.newSession': '新しいセッション',
} as const;

export type MessageKey = keyof typeof ja;

const en: Record<MessageKey, string> = {
  'app.name': 'CodeDeck',
  'common.cancel': 'Cancel',
  'common.add': 'Add',
  'common.create': 'Create',
  'common.remove': 'Remove',
  'common.close': 'Close',
  'common.none': 'None',
  'common.browse': 'Choose folder…',
  'kind.personal': 'Personal',
  'kind.team': 'Team',
  'kind.other': 'Other',
  'auth.connected': 'Connected',
  'auth.logged_out': 'Not logged in',
  'auth.unknown': 'Checking',
  'auth.check': 'Check login',
  'sidebar.profiles': 'Profiles',
  'sidebar.projects': 'Projects',
  'sidebar.addProfile': 'Add profile',
  'sidebar.addProject': 'Add project',
  'sidebar.newSessionIn': 'New session in this project',
  'sidebar.pinned': 'Default profile',
  'sidebar.history': 'Closed sessions',
  'sidebar.reopen': 'Reopen',
  'sidebar.otherSessions': 'Sessions without a project',
  'sidebar.noProjects': 'No projects yet',
  'profile.dialog.title': 'Add profile',
  'profile.name': 'Name',
  'profile.namePlaceholder': 'e.g. Personal, Work team',
  'profile.kind': 'Kind',
  'profile.color': 'Color',
  'profile.configDir': 'Config directory',
  'profile.configDirHint':
    'A folder for this profile only. Claude Code manages the login inside it; CodeDeck never reads it.',
  'profile.afterCreate':
    'After creating, claude starts with this profile. Follow the prompts and run /login.',
  'profile.error.nameRequired': 'Enter a name',
  'profile.error.nameTooLong': 'Name is too long (max 40)',
  'profile.error.nameInvalid': 'Name contains characters that cannot be used (\\ / : * ? " < > | …)',
  'profile.error.nameTaken': 'A profile with this name already exists',
  'profile.remove.title': 'Remove profile "{name}"?',
  'profile.remove.body':
    'Removes it from CodeDeck and closes its sessions. The config directory (including the login) is not deleted:\n{dir}',
  'profile.removed': 'Removed. The config directory is still there: {dir}',
  'project.dialog.title': 'Add project',
  'project.folder': 'Folder',
  'project.name': 'Display name',
  'project.pin': 'Default profile (pinned)',
  'project.pinHint': 'Sessions in this project start with this profile automatically.',
  'project.remove.title': 'Remove project "{name}" from the list?',
  'project.remove.body': 'The folder and session history are not deleted.',
  'session.dialog.title': 'New session',
  'session.project': 'Project',
  'session.noProject': 'No project (choose a folder)',
  'session.profile': 'Profile',
  'session.cwd': 'Working directory',
  'session.pinnedDefault': '(pinned)',
  'session.start': 'Start',
  'session.mismatch.title': 'Start with a profile other than the pinned one?',
  'session.mismatch.body':
    'Project "{project}" is pinned to "{pinned}". Starting with "{chosen}" means working under a different account.',
  'session.mismatch.confirm': 'Start with "{chosen}"',
  'session.state.idle': 'Not started',
  'session.state.running': 'Running',
  'session.state.exited': 'Exited',
  'session.state.external': 'External terminal',
  'session.openExternal': 'Open in external terminal',
  'session.openExternal.title': 'Open in an external terminal?',
  'session.openExternal.body':
    'Closes the in-app terminal and resumes the same conversation in your OS terminal. There, Discord input and status detection are unavailable (unless hooks are set up).',
  'session.external.banner': 'This session is running in an external terminal',
  'session.external.limits':
    'Discord input and status detection are unavailable. Quit claude in the external terminal, then bring it back.',
  'session.reclaim': 'Bring back to app',
  'session.exited': 'claude exited (code {code})',
  'session.restart': 'Resume',
  'session.close': 'Close tab',
  'session.remove': 'Remove from history',
  'session.new': 'New session',
  'session.startFailed': 'Could not start: {msg}',
  'empty.welcome': 'Welcome to CodeDeck',
  'empty.step1': 'Add profiles (personal, team, …)',
  'empty.step2': 'Add a project folder and pin its default profile',
  'empty.step3': 'Start a session. No more account switching',
  'empty.noSession': 'No open sessions',
  'claude.notFound': 'The claude command was not found. Install Claude Code and make sure it is on PATH.',
  'claude.installGuide': 'Open install guide',
  'git.missing': 'Git for Windows was not found. Claude Code needs it for its Bash tool.',
  'git.installGuide': 'Get Git for Windows',
  'shortcut.newSession': 'New session',
};

export type Locale = 'ja' | 'en';
const dictionaries: Record<Locale, Record<MessageKey, string>> = { ja, en };

export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[locale];
  const raw = (dict as Record<string, string>)[key] ?? (ja as Record<string, string>)[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
}

export function isMessageKey(key: string): key is MessageKey {
  return key in ja;
}
