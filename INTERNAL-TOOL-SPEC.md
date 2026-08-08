# Internal tool — feature specification

Living document. Each feature records **required behaviour** (owner-specified), **what exists today**
(verified against live AWS, not assumed), and **the gap**. Written so a gap is a work item, not a
surprise discovered in a demo.

---

# Feature 1 — Search for a customer, then open their dashboard

## 1.1 Required behaviour

1. An internal user can search for a customer by **first name**, **last name**, or **email**.
2. Clicking a search result opens that customer's dashboard, showing:
   1. **Vehicles in the customer's garage**
   2. **Listings**
   3. **Wishlist**
   4. **Number of offers made**
   5. **Cars sold**
   6. **Cars purchased**
3. Several of these sections render as **list views**, not just counts.
4. Clicking a vehicle opens **vehicle details**.

## 1.2 What exists today (verified 2026-07-29)

| Capability | Endpoint | Lambda | State |
|---|---|---|---|
| Search by name/email | `GET\|POST /customers/search` | **`ZoooomInternalCustomerSearch`** | ✅ built 2026-07-29, all 3 envs |
| ~~Search (old route)~~ | `GET\|POST /SearchConsumer` | `ZoooomSearchForConsumers` | ❌ mechanic-scoped, 400s without `mechanicId` — see 1.3.1 |
| Typeahead first / last / email | `/ZoooomConsumerUserFirstNameTypeAhead`, `…LastNameTypeAhead`, `/ZoooomConsumerEmailTypeAhead` | 3 lambdas | ✅ |
| Customer record + garage | `GET /GetConsumerDetail/{customerId}` | `ZoooomInternalGetCustomerDetail` | ✅ returns `{customer, vehicles}` |
| Garage list | `GET /GetConsumerDetail/GetConsumerVehicle/{customerId}/vehicles` | `ZoooomInternalGetCustomerVehicle` | ✅ |
| **Vehicle detail** | `GET /…/vehicles/{vehicleId}` | `ZoooomInternalGetCustomerVehicle` | ✅ requirement 4 already met |
| Wishlist | `POST /wishlist/get_wishlist` | `ZoooomGetWishlist` (consumer lambda) | ⚠️ see 1.3.3 |
| Listings | `GET /listings` | `ZoooomInternalListingsManagement` | ❌ whole-table scan, **cannot filter by customer** |
| Offers made | — | — | ❌ **no endpoint** |
| Cars sold | — | — | ❌ **no endpoint** |
| Cars purchased | — | — | ❌ **no endpoint** |

Data model backing each section:

| Section | Table | Key / index | Per-customer lookup |
|---|---|---|---|
| Garage | `ZoooomVehicle_{env}` | PK `vin` + SK `userId`, GSI **`userId-index`** | ✅ Query |
| Listings | `ZoooomVehicleListing_{env}` | PK `id`, GSI `listingStatus-index` only | ❌ full Scan (see 1.3.2) |
| Wishlist | `ZoooomWishlist_{env}` | PK `wishlistId` + SK `userId`, no GSI | ⚠️ Scan (tables are tiny: 17 prod rows) |
| Offers made | `ZoooomOffers_{env}` | GSI **`byBidderIdIndex`** | ✅ Query on `bidderId` |
| Cars sold | `ZoooomDeals_{env}` | GSI **`bySellerIdIndex`** | ✅ Query, but see 1.3.4 |
| Cars purchased | `ZoooomDeals_{env}` | GSI **`byBuyerIdIndex`** | ✅ Query, but see 1.3.4 |

## 1.3 Gaps and decisions

### 1.3.1 ⚠️ CORRECTED — customer search could not work at all (now fixed)

An earlier version of this document said search "can silently miss matches beyond page one". Reading
the full source proved that too generous. `/SearchConsumer` routes to `ZoooomSearchForConsumers`, whose
first act is:

```js
if (!mechanicId) return { statusCode: 400, body: { error: "mechanicId is required" } };
```

It is a **mechanic-scoped** search — "customers who had service performed by *this* mechanic" — that
first scans `ZoooomServiceRecord` for the mechanic's vehicles and only then filters users. Verified by
invoking it: a plain `{searchTerm:"sheng"}` returns **400 `mechanicId is required`**, and with a
mechanicId it returns only that mechanic's customers. So a staff member searching a customer by name
was never going to get results.

It also **cannot be repurposed**: `ZoooomMechanics POST /searchforconsumers` routes to the same
function, so the mechanic app depends on the mechanicId behaviour.

`ZoooomInternalSearchForUser` is closer in intent but is **not routed anywhere**, and caps its Scan at
`Limit: 100` items with no paging — a known dead end on a growing table.

**Fixed** with a purpose-built function; see 1.4.2.

### 1.3.2 Listings have almost no owner, and no index to find one by
`ZoooomVehicleListing_prod` holds **8,615 rows of which only 14 carry a `userId`** — the other 8,601 are
imports (`importSource: title` / `vin-decode`, i.e. the craigslist pipeline). There is **no GSI on
`userId`**, so "this customer's listings" means scanning 8,615 rows per page view.

**Decision:** add a **sparse GSI `userId-index`** on `ZoooomVehicleListing_{env}`. Sparse is exactly
right here — only the ~14 real user listings carry the attribute, so the index stays tiny and the
lookup becomes an exact Query. Imported listings correctly never appear in a customer's list.

### 1.3.3 Wishlist per-customer needs a Scan
`userId` is the **sort** key, so it cannot be queried alone. Tables are currently tiny (17 prod / 10 dev
rows across 7 / 5 users) so a filtered Scan is acceptable today; revisit with a GSI if the wishlist grows.

### 1.3.4 ⚠️ "Cars sold" and "cars purchased" have no terminal state to key on
`ZoooomDeals` status vocabulary in prod is `LISTED / ARCHIVED / UNLISTED / NEGOTIATING /
PENDING_LISTING / CANCELLED`. **There is no `SOLD` or `COMPLETED` status.** Across 26 prod deals exactly
**1** has `completedAt` set, and 0 dev deals do.

So a completed sale is currently only identifiable by the dual-confirm fields the sale-completion flow
writes: `sellerConfirmedAt`, `buyerConfirmedAt`, `completedAt`.

**Decision:** treat `completedAt` as the source of truth for sold/purchased, and additionally surface
`awaitingConfirmation` (exactly one side confirmed) so staff can see sales in flight. **Follow-up for
the sale-completion flow: set a terminal `SOLD`/`COMPLETED` status** — counting completed sales by the
presence of a timestamp is fragile, and today's numbers will read as near-zero because the terminal
state was never written.

### 1.3.5 Counts vs lists
Requirement 2 asks for counts on items 4–6 and requirement 3 says some sections are lists. The endpoint
therefore returns **both** for every section — `count` plus `items` — so the UI can render a stat tile
or a list view from one response without a second call.

## 1.4 Implemented

**`ZoooomInternalCustomerOverview`** — `GET /GetConsumerDetail/{customerId}/overview`, behind
`ZoooomInternalStaffAuth`, one call returning all six sections:

```jsonc
{
  "customer":  { "id", "firstName", "lastName", "email", "phone", "createdAt" },
  "garage":    { "count", "items": [ { "vin","year","make","model","trim","mileage","serviceRecordCount" } ] },
  "listings":  { "count", "items": [ { "id","title","price","listingStatus","createdAt","isVerified" } ] },
  "wishlist":  { "count", "items": [ { "wishlistId","year","make","model","vin","price","status" } ] },
  "offersMade":{ "count", "items": [ { "id","amount","status","dealId","createdAt","vehicleTitle" } ] },
  "sold":      { "count", "awaitingConfirmation", "items": [ { "dealId","vin","vehicleTitle","completedAt","buyerName","amount" } ] },
  "purchased": { "count", "awaitingConfirmation", "items": [ { "dealId","vin","vehicleTitle","completedAt","sellerName","amount" } ] },
  "truncated": { "listings": false, "wishlist": false }   // honest about any bounded scan
}
```

Vehicle detail is unchanged and already satisfied by
`GET /GetConsumerDetail/GetConsumerVehicle/{customerId}/vehicles/{vehicleId}`.

`truncated` exists because a bounded scan that silently stops is the same failure as 1.3.1 — if a cap
is hit, the response says so rather than presenting a partial list as complete.

### 1.4.2 `ZoooomInternalCustomerSearch` — `GET|POST /customers/search`

Live in **all three envs** (dev `$LATEST`, staging v1, prod v2 — each with its own `USER_TABLE`).

```
?q=<term>                        >=2 chars; matches firstName, lastName, email, phone and full name
&firstName= &lastName= &email=   exact-field substring search (any combination)
&limit=25                        default 25, max 200
```

Returns `{ customers:[{id,firstName,lastName,name,email,phone,createdAt,vehicleCount}], count,
totalMatches, truncated, scanned, searchedBy }`.

Behaviour decisions:
- **Multi-word queries match order-independently** — `"wang sheng"` finds `"Sheng Wang"`. Staff type
  names in whichever order they have them; a search that only understands "first last" fails half the
  time and looks broken.
- **ALL tokens must match** (not any), so `"sheng wang"` doesn't return every Wang plus every Sheng.
- **The scan is exhausted, not sampled.** DynamoDB `contains` is case-sensitive, so matching has to
  happen in the function — which makes completeness the function's responsibility. Bounded by
  `SCAN_CAP` with a `truncated` flag, because "no results" and "no results so far" are different
  answers and only one of them is safe to show a staff member.
- Results are sorted deterministically (last, first, email) so paging is stable across callers.

Verified: unauthenticated **401** in all three envs, `OPTIONS` **200**, authenticated dev **200**.
Matching — `q=sheng` 4, `q=wang` 3, `q=sheng wang` 3, `q=wang sheng` (reversed) **3**, `q=gmail` 13,
`lastName=wang` 3, 1-char query **400**, empty query **400**. Per-env isolation confirmed by scan
counts: staging scanned 14 rows, prod scanned 137 — each its own table, fully exhausted.


### 1.4.3 Customer directory (`GET /GetConsumers` → `ZoooomGetConsumerUsers`) — fixed 2026-07-30

Reported symptoms: "searched first name = sheng, only one result came back" and "the directory only
shows 30 records, I can't navigate to see the rest." Five defects, three backend, two frontend:

| # | Where | Defect | Effect |
|---|---|---|---|
| 1 | lambda | `contains(firstName, :v)` — DynamoDB `contains` is **case-sensitive** | `sheng` → **0 results**, `Sheng` → 4. Staff typing lower case were told the customer doesn't exist |
| 2 | lambda | `page`/`pageSize` are query-string **strings**; `startIndex + pageSize` concatenated | page 2 computed `30 + "30"` = `"3030"` and sliced 30–3030, returning the whole tail instead of 30 |
| 3 | lambda | `phone` filter never read | the Advanced Search phone field silently did nothing |
| 4 | `getConsumers.tsx` | sent **`lastname`**, API reads **`lastName`** | last-name search returned the unfiltered first page; it only looked filtered because the page filtered those 30 rows client-side |
| 5 | `ConsumersPage.tsx` | de-duplicated by **email**, and set `totalCount` to the current page's length | customers sharing an email were deleted from the view (4 rows in prod, incl. 3 accounts on one address); the total always read ≤30 so nothing showed more pages existed |

Plus the root cause of "can't navigate": **the page had no pagination controls at all** — `loadData` was
only ever called with page 1.

Fixes: filtering moved into the lambda and made case-insensitive (free — it already scanned the whole
table before paginating in memory), numeric coercion, `phone` honoured, stable sort so pages can't
repeat or skip rows, and `totalCount`/`totalPages` returned. Frontend now sends `lastName`,
de-duplicates by `id`, uses the server's counts, and renders Previous/Next.

Verified after deploy — backend `firstName=sheng` (lower case): dev 3, staging 4, **prod 4** (was 0);
prod directory `totalCount=137, totalPages=5`, page 1 = 30 rows, page 2 = 30 rows. Prev/Next present in
all three live bundles.


### 1.4.4 Audit of every other internal search surface (2026-07-30)

After the customer-directory fixes, the same four defect patterns were checked against all 14
search/list lambdas routed on the internal API — statically, then **verified by live invocation**,
because the static heuristics produced one false positive.

| Surface | Verdict |
|---|---|
| First-name type-ahead | ❌ case-sensitive `begins_with` → `sheng` gave 0, `Sheng` gave 1 — **fixed** |
| Last-name type-ahead | ❌ case-sensitive **and read `.firstName` while projecting `lastName`** → returned `[null]`; **had never worked** — fixed |
| Email type-ahead | ❌ same copy-paste: projected `email`, read `.firstName` → `[null]`; **had never worked** — fixed |
| Mechanic directory (`/GetMechanics`) | ❌ **regression from the master-table promotion** — filters used legacy `mechanic*` attributes that master records don't have, so every name/city/state filter returned 0. Also case-sensitive — **fixed** |
| Customer directory (`/GetConsumers`) | ❌ fixed earlier — see 1.4.3 |
| Vehicle search by VIN / plate | ✅ **no defect** — case-insensitive, verified with a real prod VIN in both cases |
| Listings, review queue, mechanic performance, dashboard stats, reward history | ✅ no case or paging defect found |
| Fraud review, email drafts | ⚠️ single `Scan` with **no `LastEvaluatedKey` loop** — silently truncates at DynamoDB's 1 MB page. Harmless at today's row counts, wrong as they grow. Not fixed; logged as a follow-up |

**The mechanic-directory breakage was mine.** Promoting `ZoooomInternalGetMechanic` to
`ZoooomMasterMechanic_{env}` moved it to a table whose attributes are `name`/`shopName`/`address`/
`city`/`state`/`zip`/`phone`; the filters still named the legacy table's `mechanic*` attributes. The
function normalises master → legacy names when building the **response**, but filtered on the **raw**
attributes beforehand, so the filters matched nothing while the list itself looked correct. Filtering
now runs after normalisation, which fixes the field mismatch and the case sensitivity together.

Root cause across all of these: **`contains()` and `begins_with()` are case-sensitive in DynamoDB.**
For a user-typed search box they are the wrong primitive. Where a table is small enough to scan (all of
these already scanned fully before paginating in memory), filter in the function on lower-cased values.

Verified in **prod** after promotion: `sheng` → `['Sheng']`, `wang` → `['Wang']`, email `gmail` → 20
suggestions of real addresses (was `[null]`), mechanics `costco` → `['Costco Tire Service Center']`.

### Two correctness rules the overview endpoint enforces (found while testing real data)

**Archived vehicles are not "in the garage."** `ZoooomDeleteVehicle` archives rather than hard-deletes,
so a deleted car still has a row. Counting it would tell staff a customer owns a car they deleted.
`garage.count` excludes `archived === true`; the rows are still returned under `archivedItems` with an
`archivedCount`, because hiding them entirely is its own kind of lie. Verified against a dev customer
with 1 active + 1 archived vehicle: `count=1, archivedCount=1`.

**Skeleton vehicle rows get a usable title.** 3 of 12 dev vehicles are `{vin, userId, dealId, …}` with
no year/make/model — created by a flow that never decoded the VIN. Rather than render three nulls that
read as a broken screen, each item carries a derived `title` (falling back to the VIN) and an explicit
`enriched: false`.

### Verified on dev (2026-07-29)

| Check | Result |
|---|---|
| `GET /GetConsumerDetail/{customerId}/overview`, authenticated | **200** |
| Same route, no token | **401** |
| `OPTIONS` preflight | **200** |
| Real customer (Sheng Wang) | garage 2, listings 15, wishlist 5, offers 5, sold 0, purchased 0 |
| Listings resolved via the new sparse GSI | ✅ 15 by Query, not an 8.6k-row scan |
| Archived exclusion (Jayden Tran) | ✅ active 1, archived 1, separated |
| Skeleton row rendering | ✅ `title: "JTMZFREV2JJ742118"`, `enriched: false` |
| `viewedBy` records the acting staff member | ✅ from the verified claim |

`sold`/`purchased` reading 0 is the data condition described in 1.3.4, not an endpoint fault — no dev
deal carries `completedAt`.

## 1.5 Still to do on feature 1

1. **Point the dashboard's search UI at `/customers/search`.** The backend is live in all three envs;
   the frontend still calls `/SearchConsumer`, which will keep 400ing. This is the one remaining step to
   make customer search work end to end for staff.
2. **Promote `ZoooomInternalCustomerOverview` to staging + prod.** Held deliberately: the response shape
   should settle once the remaining internal-tool features are specified, so the promotion happens once
   rather than three times. (Search was promoted immediately — its shape is simple and stable.)
3. **Decide whether `/SearchConsumer` should stay on the internal API at all.** It only makes sense on a
   mechanic-scoped screen; leaving it on the internal API invites the same confusion again.
3. **Set a terminal `SOLD`/`COMPLETED` deal status** in the sale-completion flow (1.3.4), so sold and
   purchased counts stop depending on a timestamp being present.
4. **Frontend**: build the dashboard against this response; `orphaned vehicles` exist (a dev vehicle
   whose `userId` has no `ZoooomUser` row returns 404 on overview) — decide whether staff should see them.

