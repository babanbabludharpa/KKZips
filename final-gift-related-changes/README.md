# Final gift related changes

Everything gift-related, in one drop. Paths inside this zip mirror each project
root (e.g. `backend/app/...` goes to your Laravel `app/...`).

## What changed in this round (gift visibility)

**Backend — `app/Http/Controllers/Api/V1/Mobile/MobileProductController.php`**

Gift products are not shoppable, so they must never look like catalogue
content on the website or the customer app.

1. `index()` — a product is listed only when it has at least one real
   (non-gift) variant. Gift-only products disappear from `/mobile/products`
   and from the paginator totals, so pages no longer come back short/empty.
2. `show()` — a gift product has no storefront page any more; opening its id
   directly returns 404 instead of an empty, un-buyable product detail.
3. `categories()` — a category that only exists to hold gift products (the
   auto-created **"Gifts"** bucket) is no longer returned, so it stops
   appearing in "Shop by Category", the product page filter panel and
   everywhere else the storefront reads categories. Empty categories with no
   products are kept exactly as before.

Result: the only place a gift appears now is the cart (progress bar, earned
gift lines and the "free gift unlocked" toast) and, once placed, the order
itself — gifts are order-specific, never browsable.

## Previously delivered gift fixes (still included)

- Checkout now renders the free-gift bar and earned gift lines from the
  authoritative `preview.gifts` payload.
- Gift caps roll back when an order expires or fails verification
  (`released_at` on `gift_usages`, idempotent release).
- Orders without a customer skip gift attach with a log instead of crashing on
  the required `customer_id` FK.
- Admin gift-product partial update can clear nullable fields.
- Empty tiers (all gifts deactivated) are filtered out instead of showing a
  tier that grants nothing.
- Gift markers on the order detail pages (storefront + admin) and a
  `released` badge in the admin usage log.
- Gift widgets follow the tenant theme: PRIMARY for the accent, SECONDARY for
  the strong/gradient stop, plus the project's own neutral / radius / shadow
  tokens. Admin badges use `--accent*` and neutral tokens, not CoreUI
  `success` / `secondary`.

## Backend migration

Run once per tenant after deploying:

```bash
php artisan tenants:migrate
```

This adds `gift_usages.released_at` (plus an `order_id` index) used by the
release logic.

## Not verified here

There is no PHP runtime in this environment, so the PHP files were reviewed
and brace-balanced but not linted or executed. Both frontends were built
successfully in the earlier rounds; no frontend file changed in this round.
