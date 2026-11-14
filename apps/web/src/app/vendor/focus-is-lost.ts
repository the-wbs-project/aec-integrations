/**
 * Whether keyboard focus has been lost. A click on empty space puts focus on `<body>`, or on
 * `<main id="main">` since AECI-1839 made it focusable for the skip link. Both mean the
 * vendor moved nowhere, so a re-read may take focus back.
 */
export function focusIsLost(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || active.matches('main#main') || !active.isConnected;
}
