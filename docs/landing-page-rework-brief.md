# Landing page rework — design brief

## 1. Feature summary

A tighter, more editorial landing page for AEC Integrations that communicates three core value propositions — trust (no pay-to-rank), integration intelligence, and role-based relevance — and invites visitors to share feedback via email. The page should feel like a confident statement from a peer, not a SaaS pitch.

## 2. Primary user action

Understand what AEC Integrations is building and feel convinced it addresses a real problem they have. Secondary: reach out with feedback via mailto link.

## 3. Design direction

The current page follows predictable SaaS landing page structure: neat sections, stat cards, feature grids, tag clouds. The rework should feel more like an **editorial statement** — closer to a well-written article or manifesto than a product page.

Per `.impeccable.md`: clean editorial, The Economist / Monocle energy. Restrained. Let the writing do the work. Forest anchors everything; Clay is rare and intentional. Borders over shadows. Sentence case.

**Specific shifts from current design:**
- Break the "section-label, h2, paragraph, grid" repetition
- Fewer visual elements, more confident typography and whitespace
- Lose the stat cards (they feel like SaaS metrics theatre)
- Lose the audience tags (listing every role reads as marketing, not editorial)
- No "coming soon" framing — just state what this is with confidence
- The page should feel shorter and more decisive

## 4. Layout strategy

**Three beats, not six sections:**

1. **Opening statement** — A strong headline and a few sentences that name the problem and the product. No label, no subhead hierarchy. Just a clear, confident opening. This is the emotional hook: "this is going to address a problem I have."

2. **The three beliefs** — Trust, integration intelligence, role-based relevance. Presented as editorial prose, not feature cards. Could be a single flowing section with three paragraphs, or three short statements with breathing room. The rhythm should feel like reading, not scanning.

3. **Close** — A short, direct invitation. Not a big CTA block. A sentence or two and a mailto link. Conversational, not transactional. No Typeform embed.

The page should feel like it could be read top-to-bottom in 60-90 seconds. Generous whitespace between beats. Narrow content width (current 820px max is good). No full-bleed colored sections breaking the flow — consider whether the forest background section is earning its place or just adding visual noise.

## 5. Key states

- **Default**: The only state that matters. This is a static editorial page.
- **Empty/error**: N/A — no dynamic content, no forms.
- **Hover**: Subtle on the mailto link and nav CTA per existing patterns.
- **Mobile**: Content-first page like this should translate naturally. Ensure the typography scales well and the three beliefs section doesn't collapse into a cramped list.

## 6. Interaction model

Minimal. Scroll and read. Click mailto link to send feedback. No animations beyond the existing subtle reveal-on-scroll (and consider whether even those are earning their place — editorial pages don't usually animate in). No interactive elements, no expandable sections, no carousels.

## 7. Content requirements

**Opening statement:**
- Headline that names the problem or the ambition (not "a better way to evaluate AEC technology" — that's generic)
- 2-3 sentences of body copy establishing what this is

**Three beliefs (working copy — refine during build):**
1. **Trust**: No pay-to-rank. No vendor influence on what you see. Reviews and data you can actually trust.
2. **Integration intelligence**: Built around understanding how tools connect to each other — not just what they do in isolation.
3. **Role-based relevance**: See the tools that matter for your discipline and project phase, not a firehose of everything.

**Close:**
- A direct, human sentence inviting feedback
- Mailto link (styled as inline link or minimal button, not a big CTA block)
- No "join the waitlist" / "get early access" / mailing list language

**Remove entirely:**
- "Coming soon" label
- Stat cards (67%, 73%, etc.)
- "Onboarding review" / review-related content
- Audience tags section
- Typeform embed

## 8. Recommended references

When building, pull from the impeccable skill's reference files:
- `spatial-design.md` — for the editorial rhythm and whitespace strategy
- `typography-design.md` — typography is doing most of the work here; hierarchy and scale matter
- `interaction-design.md` — for restraint guidance on hover states and the mailto link

## 9. Open questions

- **Nav CTA**: Currently says "Get early access." What should it say now? "Send feedback"? Or remove it entirely and let the closing mailto be the only action?
- **Forest section**: The dark problem section is visually dramatic but may feel like SaaS theatre. Keep a forest-background beat, or go all-bone for a more editorial feel?
- **Logo/brand mark in hero**: Currently just nav logo. Should the monogram or wordmark play a larger role in the opening?
- **Footer**: Current footer is minimal. Keep as-is?
