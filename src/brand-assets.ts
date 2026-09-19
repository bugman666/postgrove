/** Public Worker path for the inbox empty-state still. */
export const EMPTY_INBOX_SRC = "/assets/pg-empty-inbox.jpg";

export function isEmptyInboxAssetPath(pathname: string): boolean {
  return pathname === EMPTY_INBOX_SRC;
}
