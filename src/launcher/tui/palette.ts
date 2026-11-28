/**
 * Цвета и атрибуты терминального чата хранятся здесь.
 * Режим без цвета обходит и SGR, и управляющие последовательности ссылок.
 */
const palette = {
  text: '224;229;237',
  muted: '155;166;182',
  border: '103;123;145',
  accent: '97;175;239',
  mint: '127;218;199',
  violet: '197;168;238',
  code: '203;166;102',
  success: '126;204;137',
  error: '224;108;117',
  warning: '229;192;123',
} as const;

const foreground = (color: keyof typeof palette) => '38;2;' + palette[color];

const tones = {
  normal: foreground('text'),
  dim: foreground('muted'),
  border: foreground('border'),
  bold: '1;' + foreground('text'),
  accent: foreground('accent'),
  heading: '1;' + foreground('accent'),
  user: foreground('mint'),
  keyword: foreground('violet'),
  code: foreground('code'),
  link: '4;' + foreground('accent'),
  success: foreground('success'),
  error: foreground('error'),
  warning: foreground('warning'),
  selected: '1;' + foreground('accent'),
};

const backgrounds = {
  user: '31;48;51',
  tool: '35;43;54',
  composer: '36;47;59',
  selected: '42;60;79',
  code: '30;36;46',
  quote: '45;41;38',
  tableHead: '37;48;63',
  tableAlt: '33;40;49',
} as const;

export type Style = keyof typeof tones;
export type Background = keyof typeof backgrounds;

export interface Segment {
  text: string;
  style: Style;
  bold?: boolean;
  italic?: boolean;
  href?: string;
}

/**
 * Сегмент полностью закрывает свои атрибуты, чтобы перенос строки и
 * независимая перерисовка соседних областей не оставляли чужой стиль.
 */
export function paint(segment: Segment, color: boolean, background?: Background): string {
  const { text, style, bold, italic, href } = segment;

  if (!color || !text) {
    return text;
  }

  const attributes = `${bold ? '1;' : ''}${italic ? '3;' : ''}${tones[style]}`;
  const fill = background ? `;48;2;${backgrounds[background]}` : '';
  const colored = `\x1b[${attributes}${fill}m${text}\x1b[0m`;

  return href ? `\x1b]8;;${href}\x1b\\${colored}\x1b]8;;\x1b\\` : colored;
}
