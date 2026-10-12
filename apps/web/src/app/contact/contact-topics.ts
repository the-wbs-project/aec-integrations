/**
 * The `?topic=` values `/contact` understands. Kept apart from `contact.ts` so a
 * page that links here does not pull the contact page into its bundle.
 *
 * - `managed`: the plan inquiry form inline (AECI-1279). Linked as
 *   `MANAGED_CONTACT_HREF` in `shared/plan-cta/plan-cta.ts`.
 * - `add-product`: an email to support with the subject and a prompt filled in,
 *   for a product that is not in the directory (`VENDOR_PROGRAM_PAGE_SPEC.md` §6,
 *   settled 2026-10-12). Linked from Find your product on `/vendor-program`.
 *
 * Any other value is ignored. Only the page reads the topic. No API validates it,
 * because neither topic adds a field to any request.
 */
export const MANAGED_TOPIC = 'managed';
export const ADD_PRODUCT_TOPIC = 'add-product';
