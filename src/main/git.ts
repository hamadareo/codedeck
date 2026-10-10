import { execFile } from 'node:child_process';
import type { GitFile, GitStatus } from '@shared/types';

/** Max diff text sent to the UI for one file. */
export const DIFF_MAX_CHARS = 200_000;

function git(
  cwd: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      // No pager, no colors, stable paths: output is parsed, never shown raw to a shell.
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-C', cwd, ...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });
}

/** `git status --porcelain=v2 --branch -z` → branch, ahead/behind, files. */
export function parseStatusV2(out: string): Omit<GitStatus, 'isRepo'> {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    if (p.startsWith('# branch.head ')) {
      const h = p.slice('# branch.head '.length);
      branch = h === '(detached)' ? null : h;
    } else if (p.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(p);
      ahead = Number(m?.[1] ?? 0);
      behind = Number(m?.[2] ?? 0);
    } else if (p.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const f = p.split(' ');
      files.push({ path: f.slice(8).join(' '), status: xyStatus(f[1]!), added: null, deleted: null });
    } else if (p.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>  (next part: original path)
      const f = p.split(' ');
      files.push({ path: f.slice(9).join(' '), status: 'R', added: null, deleted: null });
      i++;
    } else if (p.startsWith('u ')) {
      const f = p.split(' ');
      files.push({ path: f.slice(10).join(' '), status: 'U', added: null, deleted: null });
    } else if (p.startsWith('? ')) {
      files.push({ path: p.slice(2), status: '?', added: null, deleted: null });
    }
  }
  return { branch, ahead, behind, files };
}

function xyStatus(xy: string): GitFile['status'] {
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  if (xy.includes('R')) return 'R';
  return 'M';
}

/** `git diff --numstat -z HEAD` → path → (added, deleted); binary files are "-". */
export function parseNumstat(out: string): Map<string, { added: number | null; deleted: number | null }> {
  const m = new Map<string, { added: number | null; deleted: number | null }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const mm = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(p);
    if (!mm) continue;
    let file = mm[3]!;
    // Renames: "a\tb\t" followed by the old and new path as separate entries.
    if (file === '') {
      file = parts[i + 2] ?? '';
      i += 2;
    }
    m.set(file, {
      added: mm[1] === '-' ? null : Number(mm[1]),
      deleted: mm[2] === '-' ? null : Number(mm[2]),
    });
  }
  return m;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const st = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  if (st.code !== 0) return { isRepo: false, branch: null, ahead: 0, behind: 0, files: [] };
  const parsed = parseStatusV2(st.stdout);
  // Numbers against HEAD (staged + unstaged). A repo without commits has no HEAD: use the index.
  const ns = await git(cwd, ['diff', '--numstat', '-z', 'HEAD']);
  const nums = parseNumstat(
    ns.code === 0 ? ns.stdout : (await git(cwd, ['diff', '--numstat', '-z', '--cached'])).stdout,
  );
  for (const f of parsed.files) {
    const n = nums.get(f.path);
    if (n) Object.assign(f, n);
  }
  return { isRepo: true, ...parsed };
}

/** Unified diff of one file against HEAD (untracked files: the whole file as added). */
export async function gitDiff(cwd: string, file: string): Promise<string> {
  if (file.startsWith('-')) throw new Error('bad path');
  let r = await git(cwd, ['diff', 'HEAD', '--', file]);
  if (r.code !== 0) r = await git(cwd, ['diff', '--cached', '--', file]);
  let out = r.stdout;
  if (!out.trim()) {
    // Untracked: compare with an empty file. Exit code 1 means "differences found".
    const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
    out = (await git(cwd, ['diff', '--no-index', '--', nul, file])).stdout;
  }
  return out.length > DIFF_MAX_CHARS ? `${out.slice(0, DIFF_MAX_CHARS)}\n… (truncated)` : out;
}

/** Stage everything and commit (after the user reviewed the diff and confirmed). */
export async function gitCommitAll(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
  const msg = message.trim();
  if (!msg) throw new Error('git.error.messageRequired');
  const add = await git(cwd, ['add', '-A']);
  if (add.code !== 0) return { ok: false, output: add.stderr || add.stdout };
  const c = await git(cwd, ['commit', '-m', msg], 60_000);
  return { ok: c.code === 0, output: (c.stdout + c.stderr).trim() };
}

/** The instruction sent to Claude Code for a commit message (§5: AI commit message, asked to Claude Code). */
export function commitMessageRequest(locale: 'ja' | 'en'): string {
  return locale === 'ja'
    ? 'git の現在の変更(git diff HEAD と未追跡のファイル)を確認して、この変更に合うコミットメッセージを1つ提案してください。1行目は50文字程度の要約、空行のあとに必要なら箇条書きで詳細。コミットはしないでください。メッセージだけをコードブロックで返してください。'
    : 'Look at the current git changes (git diff HEAD and untracked files) and propose one commit message for them: a summary line of about 50 characters, then a blank line and bullet points if needed. Do not commit. Reply with only the message in a code block.';
}
