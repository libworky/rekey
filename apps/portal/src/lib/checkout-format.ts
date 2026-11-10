/**
 * Copy and number formatting for the checkout page.
 *
 * Amounts are written by the currency registry in the buyer's locale, so
 * `en-IN` gets lakh grouping.
 */

import { formatMoney as formatRegistryMoney } from '@rekey.dev/shared-types/currency';

export type CheckoutLocale = 'en-US' | 'en-IN';

/**
 * The launch locales are `en` and `en-IN`; anything else reads as `en-US`.
 *
 * @example
 * checkoutLocale('en-IN,en;q=0.9'); // 'en-IN'
 */
export function checkoutLocale(acceptLanguage: string | null | undefined): CheckoutLocale {
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('en-in') ? 'en-IN' : 'en-US';
}

/**
 * @example
 * formatMoney(9900, 'USD', 'en-US'); // '$99.00'
 */
export function formatMoney(amountMinor: number, currency: string, locale: CheckoutLocale): string {
  return formatRegistryMoney(amountMinor, currency, locale);
}

/** "month" / "year", or null for a one-time purchase or an interval this copy does not name. */
export function intervalWord(interval: string | null | undefined): string | null {
  if (interval === 'MONTH') return 'month';
  if (interval === 'YEAR') return 'year';
  return null;
}

/**
 * What a recurring price says before it is paid, or null for one that does not renew.
 *
 * @example
 * renewalSentence('$19.00', 'MONTH'); // 'Renews automatically at $19.00 every month until you cancel.'
 */
export function renewalSentence(price: string, interval: string | null | undefined): string | null {
  const every = intervalWord(interval);
  return every === null ? null : `Renews automatically at ${price} every ${every} until you cancel.`;
}

/** WCAG relative luminance of a `#rgb` / `#rrggbb` colour, or null for anything else. */
function luminance(color: string): number | null {
  const rgb = rgbOf(color.trim());
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbOf(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const full = hex[1]!.length === 3 ? hex[1]!.split('').map((c) => c + c).join('') : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  }
  const fn = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/]\s*(?:1|1\.0+|100%)\s*)?\)$/i.exec(color);
  if (!fn) return null;
  const channels = [fn[1], fn[2], fn[3]].map(Number) as [number, number, number];
  return channels.every((c) => c <= 255) ? channels : null;
}

const DARK_MUTED_TEXT = '#a3a3a3';
const DARK_SURFACE = '#171717';

export function readableDarkSurface(color: string | null): string | null {
  if (color === null) return null;
  const l = luminance(color);
  const muted = luminance(DARK_MUTED_TEXT)!;
  return l !== null && l < muted && contrast(l, muted) >= MIN_TEXT_CONTRAST ? color : null;
}

export function readableDarkAccent(color: string | null, surfaces: ReadonlyArray<string | null>): string | null {
  const l = color === null ? null : luminance(color);
  if (l === null) return null;
  const behind = [DARK_SURFACE, ...surfaces].map((s) => (s === null ? null : luminance(s))).filter((s): s is number => s !== null);
  return behind.every((s) => contrast(l, s) >= MIN_TEXT_CONTRAST) ? color : null;
}

const MIN_TEXT_CONTRAST = 4.5;
/** Secondary text (`--rk-muted-fg` in app/shared-tokens.css), the lightest text drawn on a surface on both pages. */
export const MUTED_TEXT = '#525252';
const DEFAULT_ACCENT = '#171717';

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * An operator surface colour light enough to keep the page's text, down to
 * its muted secondary text, at 4.5:1 or better, or null to keep the neutral
 * default.
 *
 * @example
 * readableSurface('#808080'); // null: near-black text passes, muted text does not
 */
export function readableSurface(color: string | null): string | null {
  if (color === null) return null;
  const l = luminance(color);
  if (l === null) return null;
  return l > luminance(MUTED_TEXT)! && contrast(l, luminance(MUTED_TEXT)!) >= MIN_TEXT_CONTRAST ? color : null;
}

/**
 * The operator's accent when it keeps 4.5:1 against white, which is the pay
 * button's text, and against every surface it is drawn on as link text.
 * Otherwise the neutral default.
 *
 * @example
 * readableAccent('#ffeb3b'); // '#171717'
 * readableAccent('#0f766e', ['#d4d4d4']); // '#171717': fine on white, too faint on that surface
 */
export function readableAccent(color: string | null, surfaces: ReadonlyArray<string | null> = []): string {
  if (color === null) return DEFAULT_ACCENT;
  const l = luminance(color);
  if (l === null) return DEFAULT_ACCENT;
  const behind = ['#ffffff', ...surfaces].map((s) => (s === null ? null : luminance(s))).filter((s): s is number => s !== null);
  return behind.every((s) => contrast(l, s) >= MIN_TEXT_CONTRAST) ? color : DEFAULT_ACCENT;
}
