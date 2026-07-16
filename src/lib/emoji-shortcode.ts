/** Return the active `:shortcode` only after two typed characters. */
export function emojiShortcodeQuery(valueBeforeCaret: string): string | null {
  const match = valueBeforeCaret.match(/(?<![\w]):([a-z0-9_+\-]*)$/i);
  const query = match?.[1] ?? "";
  return query.length >= 2 ? query : null;
}
