import { useMemo, useState } from 'react';
import {
  DEFAULT_COLORS,
  defaultProfileFor,
  needsProfileConfirm,
  validateProfileName,
} from '@shared/profileRules';
import type { EnvInfo, Profile, ProfileKind, Project, Session } from '@shared/types';
import type { SshHost } from '@shared/ssh';
import { api, errorKey } from '../api';
import { useT } from '../i18n';
import { Button, ConfirmDialog, Field, Modal, inputCls } from './Modal';

const KINDS: ProfileKind[] = ['personal', 'team', 'other'];

function joinPath(home: string, ...parts: string[]): string {
  const sep = home.includes('\\') ? '\\' : '/';
  return [home.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

export function AddProfileDialog(props: {
  env: EnvInfo | null;
  profiles: Profile[];
  onClose(): void;
  onCreated(p: Profile): void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProfileKind>(props.profiles.length === 0 ? 'personal' : 'team');
  const [color, setColor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveColor = color ?? DEFAULT_COLORS[kind];
  const validation = name ? validateProfileName(name, props.profiles) : null;
  const dir =
    props.env && name.trim() ? joinPath(props.env.homeDir, '.codedeck', 'profiles', name.trim()) : '';

  const submit = async () => {
    const err = validateProfileName(name, props.profiles);
    if (err) return setError(err);
    setBusy(true);
    try {
      const p = await api.invoke('profiles:create', { name, kind, color: effectiveColor });
      props.onCreated(p);
    } catch (e) {
      setError(errorKey(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('profile.dialog.title')}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!name.trim() || !!validation || busy} onClick={submit}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <Field label={t('profile.name')}>
          <input
            className={inputCls}
            value={name}
            placeholder={t('profile.namePlaceholder')}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            aria-invalid={!!(validation || error)}
            data-testid="profile-name"
          />
        </Field>
        <fieldset>
          <legend className="mb-1 text-muted">{t('profile.kind')}</legend>
          <div className="flex gap-2">
            {KINDS.map((k) => (
              <label
                key={k}
                className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 ${
                  kind === k ? 'border-accent bg-panel-2' : 'border-line'
                }`}
              >
                <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: DEFAULT_COLORS[k] }}
                />
                {t(`kind.${k}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('profile.color')}>
          <input
            type="color"
            value={effectiveColor}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-16 cursor-pointer rounded border border-line bg-bg"
          />
        </Field>
        {dir && (
          <Field label={t('profile.configDir')} hint={t('profile.configDirHint')}>
            <code className="block break-all rounded bg-bg px-2 py-1 text-xs text-muted">{dir}</code>
          </Field>
        )}
        {(validation || error) && (
          <p role="alert" className="text-danger">
            {t(validation ?? error ?? '')}
          </p>
        )}
        <p className="text-xs text-muted">{t('profile.afterCreate')}</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function AddProjectDialog(props: {
  profiles: Profile[];
  onClose(): void;
  onCreated(p: Project): void;
}) {
  const t = useT();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState<string>(props.profiles[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const browse = async () => {
    const dir = await api.invoke('dialog:pickFolder');
    if (dir) {
      setPath(dir);
      if (!name) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? dir);
    }
  };

  const submit = async () => {
    setBusy(true);
    const p = await api.invoke('projects:create', { name, path, pinnedProfileId: pin || null });
    props.onCreated(p);
  };

  return (
    <Modal
      title={t('project.dialog.title')}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!path || busy} onClick={submit}>
            {t('common.add')}
          </Button>
        </>
      }
    >
      <Field label={t('project.folder')}>
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            data-testid="project-path"
          />
          <Button onClick={browse} className="shrink-0">
            {t('common.browse')}
          </Button>
        </div>
      </Field>
      <Field label={t('project.name')}>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('project.pin')} hint={t('project.pinHint')}>
        <ProfileSelect
          profiles={props.profiles}
          value={pin}
          onChange={setPin}
          allowNone
          testId="project-pin"
        />
      </Field>
    </Modal>
  );
}

/** Edit a profile's look and name (§4: colors are changeable). The config dir never changes. */
export function EditProfileDialog(props: { profile: Profile; profiles: Profile[]; onClose(): void }) {
  const t = useT();
  const p = props.profile;
  const [name, setName] = useState(p.name);
  const [kind, setKind] = useState<ProfileKind>(p.kind);
  const [color, setColor] = useState(p.color);
  const [icon, setIcon] = useState(p.icon);
  const [note, setNote] = useState(p.note);
  const [error, setError] = useState<string | null>(null);
  const others = props.profiles.filter((x) => x.id !== p.id);
  const validation = validateProfileName(name, others);

  const submit = async () => {
    if (validation) return setError(validation);
    try {
      await api.invoke('profiles:update', p.id, {
        name,
        kind,
        color,
        icon: [...icon].slice(0, 2).join(''),
        note,
      });
      props.onClose();
    } catch (e) {
      setError(errorKey(e));
    }
  };

  return (
    <Modal
      title={t('profile.edit.title', { name: p.name })}
      onClose={props.onClose}
      testId="edit-profile"
      footer={
        <>
          <Button onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!!validation} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('profile.name')}>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <fieldset>
        <legend className="mb-1 text-muted">{t('profile.kind')}</legend>
        <div className="flex gap-2">
          {KINDS.map((k) => (
            <label
              key={k}
              className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 ${
                kind === k ? 'border-accent bg-panel-2' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name="edit-kind"
                value={k}
                checked={kind === k}
                onChange={() => {
                  // Follow the kind's default color unless the user picked their own.
                  if (color === DEFAULT_COLORS[kind]) setColor(DEFAULT_COLORS[k]);
                  setKind(k);
                }}
              />
              {t(`kind.${k}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-4">
        <Field label={t('profile.color')}>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-16 cursor-pointer rounded border border-line bg-bg"
            data-testid="profile-color"
          />
        </Field>
        <Field label={t('profile.icon')}>
          <input className={`${inputCls} w-20`} value={icon} onChange={(e) => setIcon(e.target.value)} />
        </Field>
      </div>
      <Field label={t('profile.note')}>
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label={t('profile.configDir')} hint={t('profile.configDirFixed')}>
        <code className="block break-all rounded bg-bg px-2 py-1 text-xs text-muted">{p.configDir}</code>
      </Field>
      {(validation || error) && (
        <p role="alert" className="text-danger">
          {t(validation ?? error ?? '')}
        </p>
      )}
    </Modal>
  );
}

export function ProjectSettingsDialog(props: { project: Project; profiles: Profile[]; onClose(): void }) {
  const t = useT();
  const [name, setName] = useState(props.project.name);
  const [pin, setPin] = useState(props.project.pinnedProfileId ?? '');
  const submit = async () => {
    await api.invoke('projects:update', props.project.id, {
      name: name.trim() || props.project.name,
      pinnedProfileId: pin || null,
    });
    props.onClose();
  };
  return (
    <Modal
      title={t('project.edit.title', { name: props.project.name })}
      onClose={props.onClose}
      testId="project-settings"
      footer={
        <>
          <Button onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('project.folder')}>
        <code className="block break-all rounded bg-bg px-2 py-1 text-xs text-muted">
          {props.project.path}
        </code>
      </Field>
      <Field label={t('project.name')}>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('project.pin')} hint={t('project.pinHint')}>
        <ProfileSelect
          profiles={props.profiles}
          value={pin}
          onChange={setPin}
          allowNone
          testId="project-pin"
        />
      </Field>
    </Modal>
  );
}

export function RenameSessionDialog(props: { session: Session; onClose(): void }) {
  const t = useT();
  const [title, setTitle] = useState(props.session.title);
  const submit = async () => {
    if (!title.trim()) return;
    await api.invoke('sessions:rename', props.session.id, title);
    props.onClose();
  };
  return (
    <Modal
      title={t('session.rename.title')}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!title.trim()} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className={inputCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label={t('session.rename.title')}
        />
      </form>
    </Modal>
  );
}

export function ProfileSelect(props: {
  profiles: Profile[];
  value: string;
  onChange(id: string): void;
  allowNone?: boolean;
  pinnedId?: string | null;
  testId?: string;
}) {
  const t = useT();
  const current = props.profiles.find((p) => p.id === props.value);
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block h-4 w-4 shrink-0 rounded-full border border-line"
        style={{ background: current?.color ?? 'transparent' }}
        aria-hidden
      />
      <select
        className={inputCls}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        data-testid={props.testId}
      >
        {props.allowNone && <option value="">{t('common.none')}</option>}
        {props.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}({t(`kind.${p.kind}`)}){p.id === props.pinnedId ? ` ${t('session.pinnedDefault')}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

export function NewSessionDialog(props: {
  profiles: Profile[];
  projects: Project[];
  initialProjectId?: string | null;
  initialProfileId?: string | null;
  homeDir: string;
  sshHosts?: SshHost[];
  onManageSsh?(): void;
  onClose(): void;
  onStart(input: {
    profileId: string;
    projectId: string | null;
    cwd: string;
    sshHostId?: string | null;
  }): void;
}) {
  const t = useT();
  const [hostId, setHostId] = useState('');
  const host = props.sshHosts?.find((h) => h.id === hostId) ?? null;
  const [projectId, setProjectId] = useState<string>(props.initialProjectId ?? props.projects[0]?.id ?? '');
  const project = props.projects.find((p) => p.id === projectId) ?? null;
  const pinnedDefault = useMemo(() => defaultProfileFor(project, props.profiles), [project, props.profiles]);
  const [profileOverride, setProfileOverride] = useState<string | null>(props.initialProfileId ?? null);
  const profileId = profileOverride ?? pinnedDefault?.id ?? '';
  const [cwd, setCwd] = useState('');
  const [confirming, setConfirming] = useState(false);
  const effectiveCwd = project ? project.path : cwd || props.homeDir;

  const start = () => {
    if (host)
      return props.onStart({ profileId, projectId: null, cwd: host.remoteDir || '~', sshHostId: host.id });
    if (needsProfileConfirm(project, profileId)) return setConfirming(true);
    props.onStart({ profileId, projectId: project?.id ?? null, cwd: effectiveCwd });
  };

  if (confirming && project) {
    const pinned = props.profiles.find((p) => p.id === project.pinnedProfileId);
    const chosen = props.profiles.find((p) => p.id === profileId);
    return (
      <ConfirmDialog
        title={t('session.mismatch.title')}
        body={t('session.mismatch.body', {
          project: project.name,
          pinned: pinned?.name ?? '',
          chosen: chosen?.name ?? '',
        })}
        confirmLabel={t('session.mismatch.confirm', { chosen: chosen?.name ?? '' })}
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => props.onStart({ profileId, projectId: project.id, cwd: effectiveCwd })}
      />
    );
  }

  return (
    <Modal
      title={t('session.dialog.title')}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!profileId} onClick={start} data-testid="session-start">
            {t('session.start')}
          </Button>
        </>
      }
    >
      {props.sshHosts && (
        <Field label={t('session.where')}>
          <div className="flex gap-2">
            <select
              className={inputCls}
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
              data-testid="session-where"
            >
              <option value="">{t('session.local')}</option>
              {props.sshHosts.map((h) => (
                <option key={h.id} value={h.id}>
                  SSH: {h.name} ({h.destination})
                </option>
              ))}
            </select>
            {props.onManageSsh && (
              <Button className="shrink-0" onClick={props.onManageSsh}>
                {t('ssh.manage')}
              </Button>
            )}
          </div>
          {host && <span className="mt-1 block text-xs text-muted">{t('ssh.sessionHint')}</span>}
        </Field>
      )}
      {!host && (
        <Field label={t('session.project')}>
          <select
            className={inputCls}
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setProfileOverride(null);
            }}
            data-testid="session-project"
          >
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="">{t('session.noProject')}</option>
          </select>
        </Field>
      )}
      {!host && !project && (
        <Field label={t('session.cwd')}>
          <div className="flex gap-2">
            <input
              className={inputCls}
              value={cwd}
              placeholder={props.homeDir}
              onChange={(e) => setCwd(e.target.value)}
            />
            <Button
              className="shrink-0"
              onClick={async () => {
                const d = await api.invoke('dialog:pickFolder');
                if (d) setCwd(d);
              }}
            >
              {t('common.browse')}
            </Button>
          </div>
        </Field>
      )}
      <Field label={t('session.profile')}>
        <ProfileSelect
          profiles={props.profiles}
          value={profileId}
          onChange={setProfileOverride}
          pinnedId={project?.pinnedProfileId}
          testId="session-profile"
        />
      </Field>
    </Modal>
  );
}
