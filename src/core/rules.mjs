// An instruction document read as rules (1.2 step 1): each paragraph is one rule, and a rule's name, when it has
// one, is the bold words it opens with, without their full stops ("**Stay local.** Keep orchestration…"). A rule is
// a part of the same document, so every revision stays one whole text; a document written before rules had names
// reads as rules without names, one per paragraph, and needs no conversion.
export const ruleLimits = { name: 80, text: 4000, rules: 100 };

const named = /^\*\*([^*\n]+)\*\*[ \t]*/;

// The document's rules in order, each { title, text }; title is null for a rule without a name.
export function parseRules(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const match = named.exec(block);
      if (!match) return { title: null, text: block };
      return { title: match[1].trim().replace(/\.+$/, '').trim() || null, text: block.slice(match[0].length).trim() };
    });
}

// The document's text from its rules, which parseRules reads back as the same rules. A rule is one paragraph, so its
// text keeps no blank line; a rule without a name cannot open with bold words, which would read as its name.
export function formatRules(rules) {
  if (!Array.isArray(rules) || !rules.length || rules.length > ruleLimits.rules)
    throw new Error(`Instructions hold 1 to ${ruleLimits.rules} rules.`);
  return rules
    .map((rule, index) => {
      const at = `Rule ${index + 1}`;
      if (
        !rule ||
        typeof rule !== 'object' ||
        Array.isArray(rule) ||
        Object.keys(rule).some(key => !['title', 'text'].includes(key))
      )
        throw new Error(`${at} must be a name and a text.`);
      const title = rule.title == null ? '' : rule.title,
        text = rule.text;
      if (typeof title !== 'string' || title.length > ruleLimits.name || /[*\n\r]/.test(title))
        throw new Error(`${at}'s name must be one line of at most ${ruleLimits.name} characters, without asterisks.`);
      if (typeof text !== 'string' || text.length > ruleLimits.text)
        throw new Error(`${at}'s text must be at most ${ruleLimits.text} characters.`);
      const name = title.trim().replace(/\.+$/, '').trim(),
        body = text.replace(/\r\n?/g, '\n').trim();
      if (!name && !body) throw new Error(`${at} is empty: give it a text, or remove it.`);
      if (/\n[ \t]*\n/.test(body))
        throw new Error(`${at} is one paragraph: remove the blank lines inside it, or split it into two rules.`);
      if (!name) {
        if (named.test(body))
          throw new Error(`${at} opens with bold words, which would read as its name: give it a name.`);
        return body;
      }
      return `**${name}${/[?!]$/.test(name) ? '' : '.'}**${body ? ` ${body}` : ''}`;
    })
    .join('\n\n');
}
