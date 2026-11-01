export type FeedItem = {id: string; kind: 'post' | 'banner'; title: string; body: string};
export type Photo = {id: string; color: string; label: string};
export type Contact = {id: string; name: string};
export type ContactSection = {key: string; title: string; data: Contact[]};
export type Message = {id: string; text: string; mine: boolean};

const WORDS = ['list', 'native', 'layout', 'scroll', 'cell', 'render', 'smooth', 'item', 'engine', 'view', 'data', 'frame'];
const NAMES = ['Ada', 'Alan', 'Barbara', 'Brian', 'Claude', 'Dennis', 'Donald', 'Edsger', 'Frances', 'Grace', 'Guido', 'Hedy', 'Ivan', 'James', 'Ken', 'Linus', 'Margaret', 'Niklaus', 'Radia', 'Tim', 'Yukihiro'];
const COLORS = ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#073b4c', '#8338ec', '#fb5607', '#3a86ff'];

function sentence(seed: number, length: number): string {
  const words = Array.from({length}, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]);
  const text = words.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function makeFeed(count: number): FeedItem[] {
  return Array.from({length: count}, (_, index) => ({
    id: `post-${index}`,
    kind: index % 10 === 0 ? 'banner' : 'post',
    title: index % 10 === 0 ? `Section ${index / 10 + 1}` : `Post #${index + 1}`,
    body: sentence(index, 6 + (index % 5) * 6),
  }));
}

export function makePhotos(count: number): Photo[] {
  return Array.from({length: count}, (_, index) => ({
    id: `photo-${index}`,
    color: COLORS[index % COLORS.length],
    label: String(index + 1),
  }));
}

export function makeContactSections(): ContactSection[] {
  const contacts = NAMES.flatMap((first, i) =>
    NAMES.slice(0, 8).map((last, j) => ({id: `${i}-${j}`, name: `${first} ${last}son`})),
  ).sort((a, b) => a.name.localeCompare(b.name));
  const sections = new Map<string, Contact[]>();
  for (const contact of contacts) {
    const letter = contact.name.charAt(0);
    sections.set(letter, [...(sections.get(letter) ?? []), contact]);
  }
  return [...sections].map(([letter, data]) => ({key: letter, title: letter, data}));
}

export function makeMessages(from: number, count: number): Message[] {
  return Array.from({length: count}, (_, i) => {
    const index = from + i;
    return {id: `message-${index}`, text: sentence(index, 3 + (Math.abs(index) % 9)), mine: Math.abs(index) % 3 === 0};
  });
}
