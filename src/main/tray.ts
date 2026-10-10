import zlib from 'node:zlib';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import { translate, type Locale } from '@shared/i18n';
import { formatDuration, usageLevel, type ProfileUsage } from '@shared/usage';
import type { Profile } from '@shared/types';

// ---------- a tiny PNG encoder, so the tray icon needs no binary asset ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA pixels → PNG bytes. */
export function encodePng(
  size: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const LEVEL_RGB = {
  none: [148, 163, 184],
  ok: [34, 197, 94],
  warn: [245, 158, 11],
  danger: [239, 68, 68],
} as const;

/** Three rising bars, colored by the highest usage level across profiles. */
function icon(level: keyof typeof LEVEL_RGB): NativeImage {
  const img = nativeImage.createEmpty();
  for (const [size, scale] of [
    [16, 1],
    [32, 2],
  ] as const) {
    const [r, g, b] = LEVEL_RGB[level];
    const png = encodePng(size, (x, y) => {
      const u = size / 16;
      const bars = [
        [2, 10],
        [7, 6],
        [12, 2],
      ];
      const on = bars.some(([bx, top]) => x >= bx! * u && x < (bx! + 3) * u && y >= top! * u && y < 14 * u);
      return on ? [r, g, b, 255] : [0, 0, 0, 0];
    });
    img.addRepresentation({ scaleFactor: scale, buffer: png });
  }
  return img;
}

/** One line per profile: "personal — 5時間 42%(あと 2時間10分)· 7日 12%". */
export function trayLines(
  usages: ProfileUsage[],
  profiles: Profile[],
  locale: Locale,
  now: number,
): string[] {
  return profiles.map((p) => {
    const u = usages.find((x) => x.profileId === p.id);
    if (!u) return p.name;
    const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);
    const reset = u.fiveHour.resetAt
      ? translate(locale, 'usage.resetIn', { time: formatDuration(u.fiveHour.resetAt - now, locale) })
      : '';
    const limit = u.limitHit ? ` ⏸ ${translate(locale, 'status.limit')}` : '';
    return `${p.name} — ${translate(locale, 'usage.window.5h')} ${pct(u.fiveHour.percent)}${
      reset ? ` (${reset})` : ''
    } · ${translate(locale, 'usage.window.7d')} ${pct(u.sevenDay.percent)}${limit}`;
  });
}

/** Tray / menu-bar item with every profile's usage (§7 表示). */
export class AppTray {
  private tray: Tray | null = null;
  private level: keyof typeof LEVEL_RGB | null = null;

  constructor(
    private readonly actions: { show(): void; quit(): void },
    private readonly locale: () => Locale,
  ) {}

  update(usages: ProfileUsage[], profiles: Profile[]): void {
    const locale = this.locale();
    const levels = usages.map((u) =>
      usageLevel(Math.max(u.fiveHour.percent ?? -1, u.sevenDay.percent ?? -1, u.limitHit ? 100 : -1)),
    );
    const level = levels.includes('danger')
      ? 'danger'
      : levels.includes('warn')
        ? 'warn'
        : levels.includes('ok')
          ? 'ok'
          : 'none';
    if (!this.tray) {
      try {
        this.tray = new Tray(icon(level));
      } catch {
        return; // no tray on this desktop (some Linux setups)
      }
      this.tray.on('click', () => this.actions.show());
      this.level = level;
    } else if (level !== this.level) {
      this.tray.setImage(icon(level));
      this.level = level;
    }
    const lines = trayLines(usages, profiles, locale, Date.now());
    this.tray.setToolTip(['CodeDeck', ...lines].join('\n'));
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(lines.length
          ? lines.map((label) => ({ label, enabled: false }))
          : [{ label: translate(locale, 'usage.none'), enabled: false }]),
        { type: 'separator' },
        { label: translate(locale, 'tray.show'), click: () => this.actions.show() },
        { label: translate(locale, 'tray.quit'), click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
