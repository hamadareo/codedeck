import { describe, expect, it } from 'vitest';
import { translate } from '@shared/i18n';

describe('i18n', () => {
  it('defaults to Japanese and interpolates', () => {
    expect(translate('ja', 'profile.removed', { dir: '/x' })).toBe(
      '削除しました。設定ディレクトリは残っています: /x',
    );
    expect(translate('en', 'profile.removed', { dir: '/x' })).toBe(
      'Removed. The config directory is still there: /x',
    );
  });

  it('returns the key itself for unknown keys (e.g. raw main-process errors)', () => {
    expect(translate('ja', 'some raw error')).toBe('some raw error');
  });
});
