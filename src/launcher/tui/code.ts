import type { Segment, Style } from './palette.ts';

const families = [
  {
    names: /^(?:js|javascript|jsx|ts|typescript|tsx|json|jsonc)$/iu,
    comment: /\/\/.*|\/\*.*?(?:\*\/|$)/u,
    keywords: new Set(('as async await break case catch class const continue default delete do else export '
      + 'extends false finally for from function if import in instanceof interface let new null return '
      + 'switch this throw true try type typeof undefined var void while yield').split(' ')),
  },
  {
    names: /^(?:py|python|bash|sh|shell|zsh|yaml|yml)$/iu,
    comment: /(?<![\w$])#.*/u,
    keywords: new Set(('and as assert async await break case class continue def do done elif else esac '
      + 'except export False fi finally for from if import in is lambda local None not or pass raise '
      + 'return then True try until while with yield').split(' ')),
  },
];
const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\p{L}_$][\p{L}\p{N}_$]*|\d+(\.\d+)?/u;

/**
 * Подсветка одной строки code fence сохраняет пробелы и пунктуацию.
 * Общие токены поддерживаются для распространённых языков, остальные читаются как текст.
 */
export function codeLine(text: string, language: string): Segment[] {
  const family = families.find(({ names }) => names.test(language));

  if (!family) {
    return [{ text, style: 'normal' }];
  }

  const parts: Segment[] = [];
  const lexer = new RegExp(`(${family.comment.source})|${tokens.source}`, 'gu');
  let cursor = 0;

  for (const { 0: token, 1: comment, index } of text.matchAll(lexer)) {
    const style: Style = comment ? 'dim' : family.keywords.has(token) ? 'keyword'
      : /^["'`\d]/u.test(token) ? 'code' : 'normal';

    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), style: 'normal' });
    }

    parts.push({ text: token, style });
    cursor = index + token.length;
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), style: 'normal' });
  }

  return parts;
}
