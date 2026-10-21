/**
 * Directional selection movement across the note grid.
 *
 * The grid is CSS multi-column (masonry-like), so cards do not line up in rows
 * and list order does not match what the eye sees. Navigation therefore works
 * off measured geometry, treating the layout as columns:
 *
 * - up/down stay inside the current column, moving to the nearest card that
 *   overlaps it horizontally;
 * - left/right hop to the nearest column in that direction, then pick the card
 *   closest vertically.
 */

export interface NoteRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/** Guards against sub-pixel noise in measured rects. */
const EPSILON = 1;

function centre(rect: NoteRect): { x: number; y: number } {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

/**
 * The note that should become selected when moving `direction` from `currentId`.
 *
 * Returns the first note when nothing is selected yet, and keeps the current
 * selection when there is no card in that direction. `null` only when the grid
 * is empty.
 */
export function nextNoteId(rects: NoteRect[], currentId: string | null, direction: Direction): string | null {
  if (rects.length === 0) return null;

  const current = rects.find(rect => rect.id === currentId);
  if (!current) return rects[0].id;

  const from = centre(current);
  const forward = direction === 'down' || direction === 'right' ? 1 : -1;

  if (direction === 'up' || direction === 'down') {
    let best: NoteRect | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const rect of rects) {
      if (rect.id === current.id) continue;
      // Same column only: anything else is a sideways jump, not "up" or "down".
      if (rect.right <= current.left + EPSILON || rect.left >= current.right - EPSILON) continue;

      const distance = (centre(rect).y - from.y) * forward;
      if (distance <= EPSILON || distance >= bestDistance) continue;
      bestDistance = distance;
      best = rect;
    }

    return best?.id ?? current.id;
  }

  // Horizontal: the adjacent column wins outright, so find its distance first.
  let nearestColumn = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (rect.id === current.id) continue;
    const distance = (centre(rect).x - from.x) * forward;
    if (distance > EPSILON && distance < nearestColumn) nearestColumn = distance;
  }
  if (!Number.isFinite(nearestColumn)) return current.id;

  let best: NoteRect | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    if (rect.id === current.id) continue;
    const to = centre(rect);
    const distance = (to.x - from.x) * forward;
    if (distance <= EPSILON || distance > nearestColumn + EPSILON) continue;

    const offset = Math.abs(to.y - from.y);
    if (offset >= bestOffset) continue;
    bestOffset = offset;
    best = rect;
  }

  return best?.id ?? current.id;
}

/** Measure the rendered note cards, in document order. */
export function readNoteRects(root: ParentNode = document): NoteRect[] {
  return [...root.querySelectorAll<HTMLElement>('[data-note-id]')].map(element => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { id: element.dataset.noteId ?? '', left, top, right, bottom };
  });
}
