export interface Chunk {
  content: string;
  ordinal: number;
}

const TARGET_CHARS = 1200;
const OVERLAP_CHARS = 150;

/**
 * Split on markdown headings first so a chunk is usually one procedure, then
 * fall back to paragraph packing for long sections. Runbooks are written in
 * sections for humans; retrieval works better when it respects that.
 */
export function chunkDocument(text: string): Chunk[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const sections = splitOnHeadings(normalized);
  const chunks: string[] = [];
  for (const section of sections) {
    if (section.length <= TARGET_CHARS) {
      chunks.push(section);
    } else {
      chunks.push(...packParagraphs(section));
    }
  }

  return chunks
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((content, ordinal) => ({ content, ordinal }));
}

function splitOnHeadings(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,3}\s+\S/.test(line) && current.length > 0) {
      out.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

function packParagraphs(section: string): string[] {
  const paras = section.split(/\n{2,}/);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf.length + p.length + 2 > TARGET_CHARS && buf.length > 0) {
      out.push(buf);
      buf = buf.slice(Math.max(0, buf.length - OVERLAP_CHARS)) + "\n\n" + p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}
