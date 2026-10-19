/**
 * The `?topic=` values `/contact` understands. Kept apart from `contact.ts` so a
 * page that links here does not pull the contact page into its bundle.
 *
 * - `add-product`: an email to support with the subject and a prompt filled in,
 *   for a product that is not in the directory (`VENDOR_PROGRAM_PAGE_SPEC.md` §6,
 *   settled 2026-10-12). Its in-app link, Find your product on `/vendor-program`,
 *   was removed on 2026-10-12 (the claim dialog's typed-in step replaces it). The
 *   topic keeps working for links from outside the app.
 *
 * Any other value is ignored. That includes `managed`: its inline plan inquiry form
 * was removed on 2026-10-19 (E8.1), so that value renders the plain page. Only
 * the page reads the topic. No API validates it, because it adds no field to any
 * request.
 */
export const ADD_PRODUCT_TOPIC = 'add-product';
