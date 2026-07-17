/// Pure logic behind the three keyboard-driven overlays added in v0.9.1:
/// the Cmd/Ctrl+K command palette, the "/" slash-command autocomplete, and the
/// "@" file-mention autocomplete. Nothing here touches React or the DOM — it's
/// all plain functions over strings/arrays so it can be unit-tested directly
/// and so App.tsx stays a thin wiring layer on top of it.
///
/// WHY pure: the fiddly part of this feature is caret math (where does a
/// trigger start/end, what counts as "still typing the token"), not UI. Once
/// that's nailed down as pure functions with exhaustive tests, the React side
/// only has to call detectTrigger on every caret move and applyPick on every
/// selection — no caret bugs can hide inside JSX.

// ---- ranking (shared by the palette and both autocompletes) ----

/// Minimal shape the fuzzy ranker needs. `keywords` is an optional extra
/// blob of searchable text (e.g. "sidebar toggle panel") that doesn't show in
/// the UI but still counts as a match, so an action can be found by synonym.
export interface Filterable {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
}

/// Rank tier for a single item against a query, lower is better; `null` means
/// "does not match at all" and the item is dropped. Tiers, in order:
///   0 — title starts with the query
///   1 — query matches at a word boundary inside the title/keywords (start of
///       a word after a space/punctuation — e.g. "folder" matches "Open Folder")
///   2 — query appears anywhere as a substring of the title/keywords
/// Ties within a tier keep their original relative order (stable sort), so
/// list order is otherwise the caller's to control (e.g. MRU, alphabetical).
function rankTier(haystackTitle: string, haystackExtra: string, query: string): number | null {
  const q = query.toLowerCase();
  const title = haystackTitle.toLowerCase();
  if (title.startsWith(q)) return 0;

  // Word-boundary check: does q start right after a non-word char (or at
  // index 0, already handled above) anywhere in title or the extra blob?
  const combined = `${title} ${haystackExtra.toLowerCase()}`;
  const boundaryRe = /[^a-z0-9]/g;
  // Walk every "start of word" position in `combined` (index 0 plus every
  // index right after a boundary char) and see if the query starts there.
  let atStart = true;
  for (let i = 0; i < combined.length; i++) {
    if (atStart && combined.startsWith(q, i)) return 1;
    atStart = boundaryRe.test(combined[i]);
    boundaryRe.lastIndex = 0;
  }

  if (combined.includes(q)) return 2;
  return null;
}

/// Rank `items` by how well `title`/`keywords`/`hint` match `query`:
/// startsWith beats word-boundary beats substring; case-insensitive; ties
/// preserve input order. An empty (or whitespace-only) query is treated as
/// "no filter" — the original order comes back unchanged, so the palette
/// shows a sensible default list before the user types anything.
export function filterActions<T extends Filterable>(items: T[], query: string): T[] {
  const q = query.trim();
  if (q === "") return items.slice();

  const ranked: { item: T; tier: number; index: number }[] = [];
  items.forEach((item, index) => {
    const extra = [item.keywords ?? "", item.hint ?? ""].join(" ");
    const tier = rankTier(item.title, extra, q);
    if (tier !== null) ranked.push({ item, tier, index });
  });
  ranked.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return ranked.map((r) => r.item);
}

// ---- slash-command autocomplete ----

/// One command grok advertised via `available_commands_update`. `name` is
/// what gets typed after "/" and what gets matched against; `hint` is the
/// ACP `input.hint` (e.g. an argument placeholder) shown as secondary text.
export interface SlashCommand {
  name: string;
  description?: string;
  hint?: string;
}

/// Filter slash commands by `name` (matching also considers `description`
/// and `hint` as secondary text, same tiering as filterActions). Empty query
/// returns all commands in their advertised order.
export function filterSlash(commands: SlashCommand[], query: string): SlashCommand[] {
  return filterActions(
    commands.map((c) => ({ id: c.name, title: c.name, hint: c.hint, keywords: c.description ?? "" })),
    query,
  ).map((f) => commands.find((c) => c.name === f.id)!);
}

// ---- @-mention file autocomplete ----

/// Filter project file paths for the @-mention dropdown. Matching is
/// basename-first: a match against just the file's own name (the part after
/// the last "/") ranks the same tier as a match against the full path, but a
/// basename hit sorts ahead of a path-only hit within a tier, since "the file
/// literally named what you typed" is almost always what you want over a
/// directory name that happens to contain the query.
export function filterFiles(files: string[], query: string): string[] {
  const q = query.trim();
  if (q === "") return files.slice();

  const ranked: { file: string; tier: number; basenameHit: boolean; index: number }[] = [];
  files.forEach((file, index) => {
    const slash = file.lastIndexOf("/");
    const basename = slash === -1 ? file : file.slice(slash + 1);
    const basenameTier = rankTier(basename, "", q);
    const pathTier = rankTier(file, "", q);
    const tier = basenameTier !== null ? basenameTier : pathTier;
    if (tier === null) return;
    ranked.push({ file, tier, basenameHit: basenameTier !== null, index });
  });
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.basenameHit) - Number(a.basenameHit) ||
      a.index - b.index,
  );
  return ranked.map((r) => r.file);
}

// ---- trigger detection ----

/// What's currently being typed at the caret, if anything: a "/" command at
/// the very start of the draft, or an "@" mention token ending exactly at the
/// caret. `start`/`end` are indices into the ORIGINAL text delimiting the
/// token to be replaced by applyPick (end is exclusive, and for both kinds
/// currently always equals `caret` — the trigger is only "live" while the
/// caret sits right after it).
export interface TriggerState {
  kind: "slash" | "mention" | null;
  query: string;
  start: number;
  end: number;
}

const NONE: TriggerState = { kind: null, query: "", start: -1, end: -1 };

/// Detect an active composer trigger from the full draft text and the caret
/// (cursor) offset into it. Two triggers are recognized:
///
/// SLASH: the *whole draft* — after trimming leading whitespace — begins with
/// "/", and the caret is still positioned inside that first token (i.e. no
/// whitespace has been typed after the command name yet). This deliberately
/// only fires for a slash at the very start of the message: "/" appearing
/// later (e.g. "look at a/b") is not a command, it's just a character.
///   - "/" alone, caret=1            -> slash, query=""
///   - "/fix", caret=4               -> slash, query="fix"
///   - "/fix ", caret=5              -> null (trailing space closes it)
///   - "/fix arg", caret=8, mid-word -> slash still open (still first token,
///                                      no *following* whitespace — wait, see
///                                      note below)
///   - caret before the "/"          -> null (not editing the command token)
///
/// Note on "first token": once a space appears anywhere before the caret
/// within that leading run, the command name is considered committed and the
/// trigger closes — this mirrors "/name " immediately becoming plain text a
/// human is composing an argument for, not a command still being typed.
///
/// MENTION: caret sits immediately after an "@token" where:
///   - the "@" is preceded by start-of-string or whitespace (never mid-word,
///     so "foo@bar" does NOT trigger — only a standalone "@…"),
///   - the token (chars between "@" and the caret) contains no whitespace.
/// The mention is only "active" while the caret is at the END of the token
/// (caret === end of the run of non-whitespace chars after "@"); moving the
/// caret elsewhere in the draft closes it, matching how "still typing this
/// word" dropdowns behave everywhere else.
export function detectTrigger(text: string, caret: number): TriggerState {
  if (text === "" || caret < 0 || caret > text.length) return NONE;

  const slash = detectSlash(text, caret);
  if (slash) return slash;

  const mention = detectMention(text, caret);
  if (mention) return mention;

  return NONE;
}

function detectSlash(text: string, caret: number): TriggerState | null {
  // Find where the leading whitespace ends; the draft must begin with "/"
  // right after that (trimStart semantics — leading blank lines/spaces
  // before the "/" are tolerated, matching how a pasted or auto-indented
  // draft might still clearly be "a slash command").
  let leadStart = 0;
  while (leadStart < text.length && /\s/.test(text[leadStart])) leadStart++;
  if (text[leadStart] !== "/") return null;

  const slashIndex = leadStart;
  // Caret must be at or after the slash itself to be "in" the token.
  if (caret <= slashIndex) return null;

  // Walk forward from the slash to find the end of the first token: the
  // first whitespace char, or end of string.
  let tokenEnd = slashIndex + 1;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) tokenEnd++;

  // The trigger is live only while the caret is within [slashIndex, tokenEnd]
  // — i.e. before any whitespace has been typed after the command name. Once
  // caret > tokenEnd (caret is past a space) it's closed. Caret === tokenEnd
  // with the char AT tokenEnd being whitespace is still fine (caret is right
  // before that space, still mid-token); but if the caret itself has moved
  // past the whitespace, tokenEnd would have already grown past it since
  // tokenEnd only stops at the FIRST whitespace — so caret > tokenEnd means
  // there's a space between the token and the caret => closed.
  if (caret > tokenEnd) return null;

  return {
    kind: "slash",
    query: text.slice(slashIndex + 1, caret),
    start: slashIndex,
    end: caret,
  };
}

function detectMention(text: string, caret: number): TriggerState | null {
  if (caret === 0) return null; // nothing before the caret to be "@token"

  // Walk backward from the caret while chars are non-whitespace, looking for
  // an "@" that starts the token. Bail (no mention) if we hit whitespace
  // first without finding "@" immediately after it / at start-of-string.
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i])) {
    if (text[i] === "@") break;
    i--;
  }
  if (i < 0 || text[i] !== "@") return null;

  const atIndex = i;
  // "@" must be at start-of-string or preceded by whitespace — never mid-word
  // (so "foo@bar" does not trigger; only a standalone "@" starts a mention).
  if (atIndex > 0 && !/\s/.test(text[atIndex - 1])) return null;

  // Token is everything from just after "@" to the caret; already verified
  // whitespace-free by the backward walk above. An empty token ("@" with the
  // caret immediately after it) is still a valid, just-started mention.
  return {
    kind: "mention",
    query: text.slice(atIndex + 1, caret),
    start: atIndex,
    end: caret,
  };
}

// ---- applying a pick ----

/// Replace the trigger token `[trigger.start, trigger.end)` in `text` with
/// `replacement`, and report where the caret should land afterward (right
/// after the inserted text). `replacement` is expected to already include
/// its own trailing space (e.g. "/fix " or "@src/App.tsx ") so the user can
/// keep typing immediately without hitting space themselves.
///
/// If `trigger.kind` is null, this is a no-op: returns the original text
/// with the caret left where it was. Callers should generally not invoke
/// applyPick when kind is null, but making it safe avoids a footgun.
export function applyPick(
  text: string,
  trigger: TriggerState,
  replacement: string,
): { text: string; caret: number } {
  if (trigger.kind === null) return { text, caret: trigger.end >= 0 ? trigger.end : text.length };

  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const nextText = before + replacement + after;
  const nextCaret = before.length + replacement.length;
  return { text: nextText, caret: nextCaret };
}
