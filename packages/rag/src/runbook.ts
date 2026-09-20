export interface ParsedRunbook {
  title: string;
  categories: string[];
  body: string;
}

/**
 * A markdown runbook as the knowledge base stores it.
 *
 * Front matter is a `categories:` line; the title is the first `#` heading, or
 * the file name without one. Shared by `npm run kb:ingest` and the golden-set
 * runner, so a runbook the evaluation ingests is titled and filed exactly as
 * the live index files it, and a golden label naming a runbook by title names
 * the same document in both.
 */
export function parseRunbook(raw: string, filename: string): ParsedRunbook {
  let body = raw.replace(/\r\n/g, "\n");
  let categories: string[] = [];

  const fm = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const line = fm[1]!.match(/^categories:\s*(.+)$/m);
    if (line) {
      categories = line[1]!
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    }
    body = body.slice(fm[0].length);
  }

  const heading = body.match(/^#\s+(.+)$/m);
  const title = heading?.[1]?.trim() ?? filename.replace(/\.(md|markdown|txt)$/i, "");

  return { categories, body: body.trim(), title };
}
