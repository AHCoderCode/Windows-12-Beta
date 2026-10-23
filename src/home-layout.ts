/**
 * Reorders home-screen app IDs while keeping page membership deterministic.
 * The input order should contain each currently visible home-screen app at most once.
 */
export function reorderHomeAppIds(
  currentOrder: string[],
  draggedId: string,
  targetId: string | null,
  targetPage: number,
  pageById: Record<string, number>,
  insertAfter = false,
): string[] {
  const next = Array.from(new Set(
    currentOrder.filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== draggedId),
  ));

  if (!draggedId) return next;

  if (targetId && targetId !== draggedId) {
    const targetIndex = next.indexOf(targetId);
    if (targetIndex >= 0) {
      next.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedId);
      return next;
    }
  }

  const page = Number.isInteger(targetPage) && targetPage >= 0 ? targetPage : 0;
  let lastOnPage = -1;
  let firstAfterPage = -1;

  next.forEach((id, index) => {
    const assignedPage = Number.isInteger(pageById[id]) && pageById[id] >= 0 ? pageById[id] : 0;
    if (assignedPage === page) lastOnPage = index;
    if (firstAfterPage === -1 && assignedPage > page) firstAfterPage = index;
  });

  if (lastOnPage >= 0) next.splice(lastOnPage + 1, 0, draggedId);
  else if (firstAfterPage >= 0) next.splice(firstAfterPage, 0, draggedId);
  else next.push(draggedId);

  return next;
}
