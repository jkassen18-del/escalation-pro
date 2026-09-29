/**
 * Whether a reply typed in Slack or Linear means "this is done".
 *
 * The department answers where they already work, and saying so in the reply
 * resolves the ticket - nobody has to go and find a button. But most replies
 * are not that: "looking into it", "is it still happening?", "can you send a
 * screenshot". So the rule is deliberately narrow and easy to state: the reply
 * has to *start* with one of the words below (or a tick), and a question does
 * not count. "Fixed - the worker was restarted" resolves; "have you fixed it?"
 * and "not fixed yet" do not.
 */
export const RESOLVE_WORDS = ['resolved', 'resolve', 'fixed', 'done', 'sorted', 'completed', 'closed'] as const;

/** Slack's names for the tick emoji, as a reaction or typed as :shortcode:. */
export const RESOLVE_REACTIONS = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check']);

const TICK_CHARACTERS = /^(?:✅|✔️?|☑️?)/u;

export function saysResolved(text: string | null | undefined): boolean {
  let rest = String(text ?? '').trim().toLowerCase();
  if (!rest) return false;

  // Only the first sentence decides, so "Done. Did that help?" still counts
  // and "Done? Not yet." does not.
  const firstSentence = rest.split(/(?<=[.!?\n])/)[0].trim();
  if (firstSentence.endsWith('?')) return false;

  if (TICK_CHARACTERS.test(rest)) return true;
  const shortcode = rest.match(/^:([a-z_]+):/);
  if (shortcode && RESOLVE_REACTIONS.has(shortcode[1])) return true;

  // "#resolve" is the explicit form, for someone who wants to be unambiguous.
  rest = rest.replace(/^[#/]/, '');
  const firstWord = rest.match(/^[a-z]+/)?.[0];
  return Boolean(firstWord && (RESOLVE_WORDS as readonly string[]).includes(firstWord));
}
