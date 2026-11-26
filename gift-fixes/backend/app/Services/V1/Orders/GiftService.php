<?php

namespace App\Services\V1\Orders;

use App\Models\GiftCampaign;
use App\Models\GiftTier;
use App\Models\GiftUsage;
use App\Models\Inventory;
use App\Models\ProductVariant;
use App\Models\Tenant\Customer;
use App\Models\Tenant\Order;
use App\Models\Tenant\OrderItem;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

/**
 * ★ FREE GIFTS ENGINE
 *
 * Authority rules:
 *  - The client NEVER sends gift lines. Everything the shopper sees in the
 *    cart is display-only; this service is the only thing that decides what
 *    a cart has earned.
 *  - resolveForCart() is the read-side (preview / progress bar).
 *  - attachToOrder() is the authoritative write-side and MUST run inside
 *    the same DB transaction as order placement — it re-checks campaign
 *    caps and branch stock under lockForUpdate before writing anything.
 *  - Gift lines are stored as normal order_items (is_gift = 1, ₹0), so
 *    riders, invoices, stock deduction and cancellations all work through
 *    the existing pipeline with zero extra plumbing.
 */
class GiftService
{
    // ───────────────────────────────────────────────────────────────
    // Public payload for the cart progress bar (mobile + web).
    // Public on purpose — the cart drawer renders before login.
    // No customer/stock context here; eligibility is resolved at preview.
    // ───────────────────────────────────────────────────────────────
    public function activeCampaignPayload(): ?array
    {
        $campaign = GiftCampaign::active()
            ->with(['tiers.items.variant.product', 'tiers.items.variant.unit'])
            ->orderByDesc('id')
            ->first();

        if (! $campaign || ! $campaign->isValidToday() || $campaign->totalLimitReached()) {
            return null;
        }

        $tiers = $campaign->tiers
            ->map(fn (GiftTier $tier) => [
                'id' => $tier->id,
                'threshold_amount' => (float) $tier->threshold_amount,
                'selection_mode' => $tier->selection_mode,
                'gifts' => $tier->items
                    ->filter(fn ($item) => $item->variant && $item->variant->is_active)
                    ->map(fn ($item) => $this->formatGiftPreview($item->variant, (int) $item->quantity))
                    ->values(),
            ])
            // A tier whose gift variants are all deactivated grants nothing.
            // Showing its threshold would advertise a reward the customer can
            // never receive, so drop the tier — and drop the campaign entirely
            // if no tier has a single claimable gift left.
            ->filter(fn (array $tier) => $tier['gifts']->isNotEmpty())
            ->values();

        if ($tiers->isEmpty()) {
            return null;
        }

        return [
            'campaign' => [
                'id' => $campaign->id,
                'name' => $campaign->name,
                'tier_mode' => $campaign->tier_mode,
                'threshold_basis' => $campaign->threshold_basis,
            ],
            'tiers' => $tiers,
        ];
    }

    // ───────────────────────────────────────────────────────────────
    // Read-side resolution for order preview. Pure — no writes.
    // Returns the earned gift lines (with branch availability), the
    // progress-bar numbers and a reason code when the customer/campaign
    // cap blocks the gifts.
    // ───────────────────────────────────────────────────────────────
    public function resolveForCart(float $itemSubtotal, float $couponDiscount, int $branchId, ?Customer $customer): array
    {
        $campaign = GiftCampaign::active()
            ->with(['tiers.items.variant.product', 'tiers.items.variant.unit'])
            ->orderByDesc('id')
            ->first();

        if (! $campaign || ! $campaign->isValidToday()) {
            return ['campaign' => null, 'earned' => [], 'progress' => null, 'ineligible_reason' => null];
        }

        $basisValue = $campaign->threshold_basis === 'before_coupon'
            ? round($itemSubtotal, 2)
            : round(max(0, $itemSubtotal - $couponDiscount), 2);

        $tiers = $campaign->tiers; // ascending by threshold (relation orderBy)
        $achieved = $tiers->filter(fn ($t) => $basisValue >= (float) $t->threshold_amount)->last();

        // ── Cap checks (advisory here, re-enforced under lock at place()) ──
        if ($campaign->totalLimitReached()) {
            return [
                'campaign' => $this->campaignSummary($campaign),
                'earned' => [],
                'progress' => $this->progress($campaign, $tiers, $basisValue, null),
                'ineligible_reason' => 'campaign_limit_reached',
            ];
        }

        if ($customer && $campaign->usage_limit_per_customer) {
            // Only usages that were actually kept count against the cap —
            // a gift released because the order expired/failed is not a use.
            $uses = GiftUsage::where('gift_campaign_id', $campaign->id)
                ->where('customer_id', $customer->id)
                ->whereNull('released_at')
                ->count();

            if ($uses >= $campaign->usage_limit_per_customer) {
                return [
                    'campaign' => $this->campaignSummary($campaign),
                    'earned' => [],
                    'progress' => $this->progress($campaign, $tiers, $basisValue, null),
                    'ineligible_reason' => 'customer_limit_reached',
                ];
            }
        }

        // ── Which tiers are earned ──
        $earnedTiers = collect();
        if ($achieved) {
            $earnedTiers = $campaign->tier_mode === 'cumulative'
                ? $tiers->filter(fn ($t) => (float) $t->threshold_amount <= (float) $achieved->threshold_amount)
                : collect([$achieved]);
        }

        // ── Merge tier items into gift lines ──
        // In cumulative mode a variant may appear in several tiers — the
        // customer gets it once, at the highest configured quantity.
        $lines = [];
        foreach ($earnedTiers as $tier) {
            foreach ($tier->items as $item) {
                $variant = $item->variant;
                if (! $variant || ! $variant->is_active) {
                    continue;
                }

                if (isset($lines[$variant->id])) {
                    $lines[$variant->id]['quantity'] = max($lines[$variant->id]['quantity'], (int) $item->quantity);
                    $lines[$variant->id]['gift_tier_id'] = $tier->id;
                    $lines[$variant->id]['threshold_amount'] = (float) $tier->threshold_amount;
                } else {
                    $lines[$variant->id] = [
                        'variant' => $variant,
                        'quantity' => (int) $item->quantity,
                        'gift_tier_id' => $tier->id,
                        'threshold_amount' => (float) $tier->threshold_amount,
                    ];
                }
            }
        }

        if (empty($lines)) {
            return [
                'campaign' => $this->campaignSummary($campaign),
                'earned' => [],
                'progress' => $this->progress($campaign, $tiers, $basisValue, $achieved),
                'ineligible_reason' => null,
            ];
        }

        // ── Branch stock availability for the gift variants ──
        $inventoryMap = Inventory::where('branch_id', $branchId)
            ->whereIn('product_variant_id', array_keys($lines))
            ->get()
            ->keyBy('product_variant_id');

        $earned = [];
        foreach ($lines as $variantId => $line) {
            $inventory = $inventoryMap[$variantId] ?? null;
            $availableStock = $inventory
                ? max(0, $inventory->quantity - $inventory->quantity_reserved)
                : 0;

            $earned[] = $this->formatEarnedGift($line, $availableStock);
        }

        return [
            'campaign' => $this->campaignSummary($campaign),
            'earned' => $earned,
            'progress' => $this->progress($campaign, $tiers, $basisValue, $achieved),
            'ineligible_reason' => null,
        ];
    }

    // ───────────────────────────────────────────────────────────────
    // Authoritative write-side — called from OrderService::place()
    // INSIDE its DB transaction. Re-validates everything under locks:
    // campaign active/valid/under-total-cap, per-customer cap, and live
    // branch stock. Gifts that fail any check are silently dropped
    // (never block a paid order) and the drop is logged for audit.
    // ───────────────────────────────────────────────────────────────
    public function attachToOrder(Order $order, array $previewGifts, ?Customer $customer): void
    {
        $earned = $previewGifts['earned'] ?? [];
        $campaignId = $previewGifts['campaign']['id'] ?? null;

        if (empty($earned) || ! $campaignId) {
            return;
        }

        // gift_usages.customer_id is a required FK: a gift that cannot be
        // attributed to a customer cannot be recorded, capped or audited, so
        // it must not be granted — and this must never fatal the order
        // transaction (the signature is ?Customer for future guest checkout).
        if (! $customer) {
            Log::warning('Free gifts skipped: order has no customer', [
                'order_id' => $order->id,
                'campaign_id' => $campaignId,
            ]);

            return;
        }

        $campaign = GiftCampaign::where('id', $campaignId)->lockForUpdate()->first();

        if (! $campaign || ! $campaign->is_active || ! $campaign->isValidToday() || $campaign->totalLimitReached()) {
            return;
        }

        if ($campaign->usage_limit_per_customer) {
            $uses = GiftUsage::where('gift_campaign_id', $campaign->id)
                ->where('customer_id', $customer->id)
                ->whereNull('released_at')
                ->count();

            if ($uses >= $campaign->usage_limit_per_customer) {
                return;
            }
        }

        $attached = [];
        $dropped = [];

        foreach ($earned as $gift) {
            if (empty($gift['available'])) {
                $dropped[] = ['sku' => $gift['variant_sku'] ?? null, 'reason' => 'no_stock_at_preview'];
                continue;
            }

            $inventory = Inventory::where('product_variant_id', $gift['product_variant_id'])
                ->where('branch_id', $order->branch_id)
                ->lockForUpdate()
                ->first();

            if (! $inventory) {
                $dropped[] = ['sku' => $gift['variant_sku'] ?? null, 'reason' => 'no_inventory_row'];
                continue;
            }

            $available = max(0, $inventory->quantity - $inventory->quantity_reserved);
            if ($available < (int) $gift['quantity']) {
                $dropped[] = ['sku' => $gift['variant_sku'] ?? null, 'reason' => 'insufficient_stock'];
                continue;
            }

            $variant = ProductVariant::find($gift['product_variant_id']);
            if (! $variant || ! $variant->is_active || ! $variant->is_gift) {
                $dropped[] = ['sku' => $gift['variant_sku'] ?? null, 'reason' => 'variant_not_gift_or_inactive'];
                continue;
            }

            // Gift line — ₹0 across the board, MRP kept for display.
            OrderItem::create([
                'order_id' => $order->id,
                'product_variant_id' => $variant->id,
                'quantity' => $gift['quantity'],
                'unit_price' => 0,
                'mrp' => $variant->mrp,
                'discount_percent' => 0,
                'final_price' => 0,
                'line_total' => 0,
                'tax_rate_percent' => 0,
                'tax_amount' => 0,
                'taxable_value' => 0,
                'tax_type' => 'cgst_sgst',
                'cgst_amount' => 0,
                'sgst_amount' => 0,
                'igst_amount' => 0,
                'is_gift' => true,
                'gift_tier_id' => $gift['gift_tier_id'] ?? null,
            ]);

            $inventory->increment('quantity_reserved', $gift['quantity']);

            $attached[] = [
                'variant_id' => $variant->id,
                'sku' => $variant->sku,
                'name' => $variant->product?->name,
                'quantity' => (int) $gift['quantity'],
                'tier_id' => $gift['gift_tier_id'] ?? null,
                'mrp' => (float) $variant->mrp,
            ];
        }

        if ($dropped) {
            Log::info('Free gifts dropped at order attach', [
                'order_id' => $order->id,
                'campaign_id' => $campaign->id,
                'dropped' => $dropped,
            ]);
        }

        if ($attached) {
            GiftUsage::create([
                'gift_campaign_id' => $campaign->id,
                'customer_id' => $customer->id,
                'order_id' => $order->id,
                'items' => $attached,
                'used_at' => now(),
            ]);

            $campaign->increment('used_count');
        }
    }

    /**
     * Release the gift usage recorded for an order that never completed
     * (expired pending_payment, failed payment verification, cancellation).
     *
     * The stock reservation is released separately by OrderService — this
     * only undoes the campaign accounting so a gift nobody received does not
     * burn the campaign's usage_limit_total or the customer's
     * usage_limit_per_customer. `released_at` makes it idempotent: a second
     * call finds nothing and does nothing.
     */
    public function releaseUsageForOrder(Order $order): void
    {
        $usage = GiftUsage::where('order_id', $order->id)
            ->whereNull('released_at')
            ->first();

        if (! $usage) {
            return;
        }

        DB::transaction(function () use ($usage) {
            $campaign = GiftCampaign::where('id', $usage->gift_campaign_id)
                ->lockForUpdate()
                ->first();

            $usage->update(['released_at' => now()]);

            if ($campaign && $campaign->used_count > 0) {
                $campaign->decrement('used_count');
            }
        });
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private function campaignSummary(GiftCampaign $campaign): array
    {
        return [
            'id' => $campaign->id,
            'name' => $campaign->name,
            'tier_mode' => $campaign->tier_mode,
            'threshold_basis' => $campaign->threshold_basis,
        ];
    }

    private function progress(GiftCampaign $campaign, $tiers, float $value, $achieved): array
    {
        $next = $tiers->first(fn ($t) => (float) $t->threshold_amount > $value);

        return [
            'basis' => $campaign->threshold_basis,
            'current_value' => round($value, 2),
            'highest_earned_threshold' => $achieved ? (float) $achieved->threshold_amount : null,
            'next_threshold' => $next ? (float) $next->threshold_amount : null,
            'remaining' => $next ? round((float) $next->threshold_amount - $value, 2) : null,
        ];
    }

    /**
     * Preview card for the public /gifts/active payload (no stock data —
     * availability is resolved at checkout preview).
     */
    private function formatGiftPreview(ProductVariant $variant, int $quantity): array
    {
        return [
            'product_variant_id' => $variant->id,
            'name' => $variant->product?->name ?? 'Free Gift',
            'sku' => $variant->sku,
            'mrp' => (float) $variant->mrp,
            'quantity' => $quantity,
            'unit_abbr' => $variant->unit?->abbreviation,
            'image_url' => $this->variantImageUrl($variant),
        ];
    }

    /**
     * Full earned-gift line for the order preview payload.
     */
    private function formatEarnedGift(array $line, int $availableStock): array
    {
        $variant = $line['variant'];

        return [
            'product_variant_id' => $variant->id,
            'product_name' => $variant->product?->name ?? 'Free Gift',
            'variant_sku' => $variant->sku,
            'quantity' => $line['quantity'],
            'mrp' => (float) $variant->mrp,
            'unit_price' => 0.0,
            'final_price' => 0.0,
            'line_total' => 0.0,
            'unit_abbr' => $variant->unit?->abbreviation,
            'image_url' => $this->variantImageUrl($variant),
            'gift_tier_id' => $line['gift_tier_id'],
            'threshold_amount' => $line['threshold_amount'],
            'available_stock' => $availableStock,
            'available' => $availableStock >= $line['quantity'],
            'is_gift' => true,
        ];
    }

    private function variantImageUrl(ProductVariant $variant): ?string
    {
        if (! $variant->image) {
            return null;
        }

        return Storage::disk('public')->url('tenants/'.tenant('id').'/variants/'.$variant->image);
    }
}
