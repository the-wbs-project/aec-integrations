**Legal impact:** decision. One feature would let payment move a product's place in a list, which the Terms say never happens. Three more need Privacy Policy or review text before they ship, and several need copy fixes. Nothing needs counsel. I edited no files and posted a short version on AECI-1571.

I read the copy in all four HTML files and viewed the hero screenshots for mock-ups 7 and 8. I did not open the other screenshots.

## The one decision

**What is wrong.** Mock-ups 6 and 7 order integrations by "confirmed by more companies", and the hero ring shows "the 8 with the most evidence". Confirming an integration's data is a Managed capability on the Plans page. A vendor that pays can confirm, and a confirmed integration moves up.

**Why it matters.** The copy beside it says "Plan or license status has no effect on the order" and "No vendor pays for a place here". The Terms say ranking is "never influenced by payment". The paid tiers spec bars paid capabilities from ordering. Counsel's Q23 answer says we must be able to prove that claim.

**What to do.** Rule on one of two options:
- Order by something payment cannot touch, such as data objects on record, then partner name.
- Open the confirm capability to Free, as you did for replies and connector claims.

I have not checked how the live pair page orders today. The planning workspace should confirm how "evidence" would be computed.

## Feature by feature

| # | Feature | Verdict | What to do |
|---|---|---|---|
| 1 | "No integration on record… not proof that none exists" | none | Keep the caveat beside the statement everywhere, including the page title and description. |
| 2 | "Know of one? It does exist" | none | Open the existing correction request. The copy already asks for a public source, as the Listing Accuracy Policy requires. |
| 3 | "Watch this pair" | text | Privacy Policy first. See below. |
| 4 | "I need this too" counter | text | Privacy Policy first. See below. |
| 5 | "34 people looked up this pair" | text | Reword, add a floor, and state the use in the Privacy Policy. |
| 6 | Closest matches | text | The ordering must be described on the "How ranking works" page, which the Terms point to. |
| 7 | Ordering statements and the ring | decision | Above. |
| 8 | Vendor labels and icons | none after a copy change | Replace the check and shield icons. |
| 9 | Unclaimed note | none | Use the shared component. |
| 10 | "An API means a connection could be built" | none after a copy change | Reword. |
| 11 | Category chart, "38 of 46" | none | Computed from the record and labelled so. |
| 12 | "Updated" and "Reviewed" dates | none, with a condition | "Reviewed" needs a stored date. |
| 13 | Names and logos | conflicts with ruling 9 | Initial tiles for unclaimed partners. |
| 14 | Reviews | none, one check | Company type on a review may be new. |
| 15 | Outbound vendor links | none | The "theirs, not ours" line is good. |
| 16 | Other | see below | Two caption points. |

**3. Watch this pair.** It is a new email collected for a new purpose. The Privacy Policy lists every purpose we email people for. "One email… Nothing else" is also a promise, so the address must not join the mailing list. Decide how long an address is kept if no integration is ever added. I suggest deleting it after the email is sent, or after 12 months.

**4. I need this too.** Stopping repeat clicks needs either a flag in the browser or a server record. The Privacy Policy's cookies section names every browser key, so either route needs a line there. The public number must be the real, de-duplicated count.

**5. Look-up count.** Two words are wrong. We count visits, not people, and we keep no identifier that links visits. We also cannot exclude all automated traffic, only what we identify. Use: "Looked up 34 times in the last 90 days. Visits we identified as automated are not counted." Show it only above a floor, such as 10, so a small number cannot point at one visitor. AECI-1679 mentions a look-up count, so part of this may already be live.

**8. Icons.** A check beside "Vendor maintained" and "Listing claimed by", and a shield beside "Confirmed by both", read as verification. The Terms say "We do not describe any vendor-maintained field as verified". Use the pencil the mock-up already has for "Maintained by", and a neutral link icon for confirmations.

**9. Unclaimed note.** The mock-up says "Unclaimed. Not affiliated with or endorsed by this vendor." The approved string is "Unclaimed · not affiliated with or endorsed by this vendor". Only the punctuation differs. Counsel approved the substance, and the exact string is ours. It sits beside a small logo in mock-up 8, which is what counsel asked for.

**10. "Could be built".** The sentence does not claim any pair is buildable, so it does not break the refusal in the Stage 1.5 spec. It still uses the word we refuse. Use: "An API is not an integration. We list an integration only when we can show that one exists." For the second line use: "We have not found an integrations page published by {vendor}."

**12. Dates.** "Updated {date}" on vendor text is required by the Terms. "Reviewed 14 Sep 2026" says we reviewed the listing that day. I do not know whether we store such a date. If not, drop it.

**13. Logos.** Ruling 9 allows a small sourced logo only on an unclaimed listing's own page. Lists, cards and rows show the initial tile. The ring in mock-up 7 shows eight partner logos large, and partners can be unclaimed. Vendor-coloured card headers are not covered by the record. My reading is no brand colour for unclaimed products.

**14. Reviews.** "Reviews are checked before they appear" matches the Review Guidelines. The five-review threshold matches the spec. The Privacy Policy says a reviewer's firm is never shown. If "company type" is not shown on reviews today, it needs a line there.

**16. Captions.** "Written by Bluebeam. Updated 3 Oct 2026" departs from ruling 5, which fixed "Maintained by {Vendor} · updated {date}". The page-level "Vendor maintained" pill overstates it when only some fields are the vendor's.

## The three points already flagged

- **Unclaimed note reworded:** correct, but harmless. Use the component.
- **"Could be built":** not a conflict in meaning, but reword it.
- **Shield and check icons:** confirmed. Change them.

## Three lists

**Copy that must change before any build**
- The look-up count sentence and its "automated traffic" line.
- The two API sentences in mock-up 8.
- "Written by" captions, to ruling 5's wording.
- The check and shield icons.
- Partner logos to initial tiles where the partner is unclaimed.

**Legal text to write before the feature ships**
- Privacy Policy, "What we collect": the watch-a-pair email and its one use.
- Privacy Policy, "Retention": how long a watch address is kept.
- Privacy Policy, "Cookies and similar technologies": the repeat-click flag, if it lives in the browser.
- Privacy Policy, "Our own visit count": that we publish aggregate look-up counts.
- "How ranking works": the ordering of closest matches and of a product's integrations.

**Questions for counsel**
- None. The record covers each point, or I have said where I am giving my own reading: brand colours, "Reviewed" dates and the look-up floor.

## Summary

- Rule on the ordering: payment-proof ordering, or open the confirm capability to Free.
- Decide the retention for a watch address.
- Approve the reworded look-up sentence and a floor of 10.
- Send the copy list to the design workspace before a plan is written.
- Have the planning workspace check whether "Reviewed" dates and review "company type" exist today.
- File the Privacy Policy lines as text items when features 3, 4 or 5 are scheduled.