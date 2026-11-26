---
title: How ranking works
description: What decides the order of search results and lists on AEC Integrations, what never does, and what a paid plan changes.
section: trust
order: 1
version: 1.2
last_updated: November 27, 2026
---

The order of every list on AEC Integrations comes from fixed rules, applied the same way to every listing. This page names the things that decide the order and says, in words, how much each one counts. It does not publish a formula or any weights.

## Search

[Search](/search) has a Products tab and a Vendors tab. The words you type decide which listings appear. The sort you choose decides their order.

The Products tab offers the same sorts as the products list below, and starts in the same order, **Newest**. The Vendors tab sorts by **Name (A–Z)**, which ignores capital letters. In search, **Highest rated** puts products with too few reviews to show a rating last, as the list does.

When two listings are level on the sort you chose, two more steps decide between them.

**First, how well a listing matches what you typed.** This counts most. A listing ranks higher when it matches more of your words, with fewer typos, and with the words closer together. Where the match is found matters too.

- For a product, a match in its name counts most. Then come its vendor's name, then its categories, audiences, phases and trades, then its description. Common alternative names for a trade also match, so a search in everyday words can still find the right products.
- For a vendor, a match in the company name counts most. Then come its description, then its headquarters.

**Second, when listings match about equally well, completeness decides.** A complete listing tells a buyer enough to judge it.

- A product listing counts as complete when it has a description, a website, a logo and at least one category.
- A vendor listing counts as complete when it has a description, headquarters, a website and a logo.

Complete listings come first. Listings with a description that are missing some of the rest come next. Listings with no description, or missing most of the rest, come last.

For products only, one more thing breaks a tie after completeness: the number of published reviews. More reviews come first. After that, listings that are still level have no set order.

The same two steps order the suggestions that appear under the search box as you type.

A change to a listing can take up to a day to show in search.

## Browsing lists

The [products list](/products) and every category, audience, phase and trade page start in **Newest** order, with the most recently added products first. You can change the order:

- **Name (A–Z)**, alphabetical, ignoring capital letters.
- **Recently updated**, the most recently changed listings first.
- **Highest rated**, by average rating. Each review counts at its latest rating: when a reviewer adds an update with new ratings, the average uses those. Products with too few reviews to show a rating come after every product that shows one. More reviews break a tie.
- **Most reviewed**, by the number of published reviews.

Filters change which products you see, not their order.

## The home page

- **Most viewed**, under the search box, names up to five products people viewed most over the past thirty days. We count views our traffic classifier judged to be a person, or could not decide about. Views it judged automated, and our own visits, are left out. Classification runs once a day, so a view counts from the next day. A view of a page about two products counts for both. A product needs a few views to be listed. We update it once a day. When no product has enough views, the row is labelled **Largest categories** and names the five categories with the most products instead. That fallback counts products, not views.
- **Browse the directory** lists the categories with the most products, the trades with the most products, every project phase in project order, and a fixed list of roles. A trade is listed once at least one product carries it.

## The Browse menu

**Browse**, in the site header, opens a menu of places to start. It names no product and no vendor. It has five columns:

- **Explore** starts with **All products**, then four key categories: AI, Project management, BIM authoring, and Accounting and ERP. We chose these four ourselves. They are an editorial pick, not a ranking, and they are listed in the order we chose.
- **Categories** lists the seven categories with the most products, leaving out the four key categories.
- **Phases** lists every project phase, in project order.
- **Audiences** lists the seven audiences with the most products.
- **Trades** lists the seven trades with the most products. A trade is listed once at least one product carries it.

When two have the same number of products, they are listed A to Z. A category, audience or trade with no products is not listed. Each of the other four columns ends with a link to its full list. The counts are the products tagged with each one. We set every tag when we list a product. A vendor that has claimed a product can change that product's categories, on any plan. A vendor can change a product's audiences and trades only when that product is on a paid plan. So a vendor's changes can move these counts, and for audiences and trades that takes a paid plan. The counts never move a product in any list.

## A product page

- **The integrations wheel**, at the top of a product page, shows the products this one has an integration with on record. On a connector's own page it shows the products the connector reaches instead, as the last point below says. A product with neither has no wheel. Left and right arrows step through its slides. It never moves on its own. The first slide is **All integrations**. Then comes one slide for each category, A to Z by category name. A category slide shows only the products that carry that category, so a product with two categories is on both slides. A category with no products for this page is not offered.
- On a slide, each product is one tile. All tiles are the same size. They are placed A to Z by product name, ignoring capital letters, clockwise from the top. On a wide screen, a slide with many products uses two rings. The A to Z order starts at the top of the inner ring, runs clockwise, then continues from the top of the outer ring. Whether a slide uses one ring or two depends only on how many products it has and how wide your screen is. Neither ring is a rank. A tile shows the product's logo when we have one, and its initial when we do not. The card that opens from a tile marks an unclaimed listing.
- When a slide has more products than fit as tiles on your screen, it shows no products. It shows one dot for each integration and a count. The dots are not links and name no product. The switch depends only on how many products the slide has and how wide your screen is. A slide shows every matching product or none. We never pick a subset.
- On most product pages the wheel shows only integrations in which this product is one of the two products. When an integration runs through a connector tool, the tile is the other product, not the connector. On a connector's own page, the wheel shows the products its integrations reach: every product at either end of an integration it powers, or delivers on a Sync Service. That is the same set as the line under its name, "Connects N products" or "Syncs N products". They are on one slide, A to Z by product name, ignoring capital letters, with no category slides. On a connector's own page, a dot stands for one product, not one integration. A connector that reaches no product this way shows the products it has an integration with itself. A product that is both an application and a connector shows its own integrations. It shows the products it reaches only when it has none of its own. The wheel counts products, so its count can differ from the page's integration total.
- **Integrations** lists the products this one integrates with, A to Z by the other product's name, ignoring capital letters, then by the integration's name.
- Integrations that run through a connector tool are grouped by connector. The connector with the most integrations comes first, then A to Z by connector name. Integrations whose connector is not named come last. Inside each group, the order is the same as above.
- When a product has thirteen or more integrations and no connector group, and the products it integrates with fall into fewer categories than half that number, the integrations are grouped by the other product's category. The groups are A to Z by category name. A product with more than one category appears in each of its groups. Products with no category on record come last. Inside each group, the order is the same as above. **One list** shows the same integrations in the order above, without groups.
- **What it syncs**, on a Sync Service's own page, lists the types of data its integrations move, A to Z by name. The number of integrations beside each one does not change the order.
- **Integrations it powers**, on a connector's own page, groups the pairs it connects around the products they share. On a Sync Service the section is called **Integrations it delivers**, and it is ordered the same way. The group with the most products comes first, then A to Z by product name. The products inside a group, and pairs that share no product, are listed A to Z.
- **Extensions built within** a product, and the products an extension is **Built within**, are listed A to Z by name.
- **Categories**, **phases** and **trades** follow a fixed order we set, the same on every product page. Phases follow project order. Where we have set no order, they are listed A to Z. **Audiences** are listed A to Z.
- **Similar products**, near the end of a product page, lists up to six products that share a category with it, A to Z by name, ignoring capital letters. When more than six do, the first six in that order are shown. A product whose name comes later in that order is not shown.

## A pair page

- **Integrations** between the two products are listed in three groups. First come the integrations we record between the two products. Second come the integrations we record under the connector that delivers them. The first two groups are each A to Z by the integration's name, ignoring capital letters.
- Integrations delivered by a **Sync Service** are the third group. When two or more Sync Services deliver the same pair, they are listed A to Z by the name of the company that offers each one, ignoring capital letters. One whose offering company is not on record comes after them. The order never reads a vendor's plan.

## A pair page with no integration

- **Closest matches on record**, on a page about two products with no integration on record, keep one product and swap the other. A product appears when it has an integration on record with the product you keep and shares a category you left on with the other product. They are listed A to Z by name, ignoring capital letters. If you pick data, a product must have all of it on record with the product you keep. A search by product or vendor name only narrows the list. It never changes the order. The order never reads a vendor's plan. Who appears depends only on the integrations and data on record. A vendor on any plan can add data to its own integrations, so its product can match a data filter it would not match otherwise.

## What does not count

None of these changes where a listing appears in search:

- How many integrations a product has, or how many products a vendor has. You can still filter by those counts in search.
- Ratings. They decide the "Highest rated" sort, and nothing else. An update to a review changes ratings only through the average, and never the review count.
- How many people view a page.
- Trades, beyond matching your words. A trade helps a product be found when you search for that trade or filter by it. It gives no boost of its own.
- Whether a connector is an integration platform or a Sync Service, in search. You can filter by it there and in the lists. It does set the order on a pair page, as that section says.
- Which plan a vendor is on.
- A vendor's reply to a review.

## What a plan does not buy

Payment never changes the order in which products are listed or returned in search. A paid plan lets a vendor edit more of its own listing, such as the trades, audiences and phases tagged on its product, which can help it match more searches and appear on more category pages. There is no sponsored placement and no promoted tier. Completeness reads only what the listing says, never the vendor's plan. A vendor can fill in every detail that counts towards it on the free plan.

We hold ourselves to this with automated checks, not only a promise. [How we research listings](/methodology) sets out the rule and how we test it.

## Corrections are free

Anyone can ask us to correct a listing, at no charge. A more complete, accurate listing is ranked by the same rules as every other one. See [Requests and corrections](/docs/reviewers/requests-and-corrections).

## Versions

We record this page as a dated version, because the Terms of Service and the Vendor Terms link it. Each change to this page is a new version.

- [Version 1.2](/docs/trust/how-ranking-works/v1.2) (this version): recorded November 27, 2026. Adds the Browse menu, the integrations wheel at the top of a product page, the order of the other lists the redesigned product page adds, the order of the integrations on a pair page, what a Sync Service's page lists and the closest matches on a pair page with no integration. Names the home page row Most viewed and its fallback Largest categories. Says "product" where earlier versions said "partner". Says payment never changes the order of listings or search results, and that a paid plan can put a product on more category pages.
- [Version 1.1](/docs/trust/how-ranking-works/v1.1): recorded November 18, 2026. Says what a paid plan does change, and adds the order of each list on a product page.
- [Version 1.0](/docs/trust/how-ranking-works/v1.0): recorded November 16, 2026. The first recorded version.

## Related

- Next: [Agreement states](/docs/trust/agreement-states).
- [How we research listings](/methodology), our full statement of how the directory works.
